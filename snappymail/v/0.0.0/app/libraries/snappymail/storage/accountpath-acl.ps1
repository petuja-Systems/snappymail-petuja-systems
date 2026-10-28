[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)]
	[ValidateSet('PrepareDemoRoot', 'VerifyDemoRoot', 'VerifyDemoTree', 'VerifyStorageBasePath', 'VerifyStoragePath', 'VerifyStoragePathOrMissing', 'VerifyPrivateFile', 'SyncDirectory')]
	[string] $Operation,
	[Parameter(Mandatory = $true)]
	[string] $Path,
	[string] $PrivateBase
)

$ErrorActionPreference = 'Stop'
$fileSystemRights = [System.Security.AccessControl.FileSystemRights]
$accessControlType = [System.Security.AccessControl.AccessControlType]
$inheritanceFlags = [System.Security.AccessControl.InheritanceFlags]
$propagationFlags = [System.Security.AccessControl.PropagationFlags]
$trustedWriteSids = @('S-1-5-18', 'S-1-5-32-544')
$trustedOwnerSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$safeReadMask = [int64] 1 -bor [int64] 8 -bor [int64] 32 -bor [int64] 128 -bor [int64] 131072 -bor [int64] 1048576

function Get-NormalPath([string] $Value) {
	$full = [System.IO.Path]::GetFullPath($Value)
	$root = [System.IO.Path]::GetPathRoot($full)
	if ($full.Length -gt $root.Length) {
		$full = $full.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
	}
	return $full
}

function Test-PathBelow([string] $Candidate, [string] $Parent) {
	$parentPrefix = $Parent.TrimEnd('\') + '\'
	return $Candidate.StartsWith($parentPrefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-Sid([System.Security.Principal.IdentityReference] $Identity) {
	try {
		return $Identity.Translate([System.Security.Principal.SecurityIdentifier]).Value
	} catch {
		throw 'An ACL identity could not be resolved to a SID.'
	}
}

function Get-NormalizedRights([System.Security.AccessControl.FileSystemRights] $Rights) {
	$value = [int64] $Rights
	if ($value -lt 0) {
		$value += 4294967296
	}
	return $value
}

function Assert-NoReparseAncestors([string] $Value) {
	$current = Get-NormalPath $Value
	while ($true) {
		$item = Get-Item -LiteralPath $current -Force
		if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
			throw ('Refusing a reparse point in the storage path: ' + $current)
		}
		$parent = [System.IO.Directory]::GetParent($current)
		if ($null -eq $parent -or $parent.FullName -eq $current) {
			break
		}
		$current = Get-NormalPath $parent.FullName
	}
}

function Get-AttributesOrMissing([string] $Value) {
	try {
		return [System.IO.File]::GetAttributes($Value)
	} catch {
		$cause = $_.Exception
		while ($null -ne $cause -and
			$cause -isnot [System.IO.FileNotFoundException] -and
			$cause -isnot [System.IO.DirectoryNotFoundException]) {
			$cause = $cause.InnerException
		}
		if ($cause -is [System.IO.FileNotFoundException] -or
			$cause -is [System.IO.DirectoryNotFoundException]) {
			return $null
		}
		throw
	}
}

function Assert-StorageBasePath([string] $Value) {
	if ($Value -match '(^|[\\/])\.{1,2}([\\/]|$)') {
		throw 'The account storage base path must not contain dot segments.'
	}
	$targetPath = Get-NormalPath $Value
	$root = [System.IO.Path]::GetPathRoot($targetPath)
	if ([string]::IsNullOrWhiteSpace($root)) {
		throw 'The storage base path must be absolute.'
	}
	$current = Get-NormalPath $root
	$attributes = Get-AttributesOrMissing $current
	if ($null -eq $attributes) {
		throw 'The storage base path root is unavailable.'
	}
	if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) {
		throw ('Refusing a reparse point in the storage path: ' + $current)
	}
	$relative = $targetPath.Substring($root.Length).Trim('\')
	if ([string]::IsNullOrWhiteSpace($relative)) {
		throw 'The account storage base must be below a filesystem root.'
	}
	$segments = $relative.Split([char[]]@('\'), [System.StringSplitOptions]::RemoveEmptyEntries)
	$baseExists = $true
	for ($index = 0; $index -lt $segments.Length; ++$index) {
		$parent = $current
		$current = [System.IO.Path]::Combine($parent, $segments[$index])
		$attributes = Get-AttributesOrMissing $current
		if ($null -eq $attributes) {
			Assert-NoUntrustedInheritedAllows $parent
			Assert-AncestorAcl $parent
			$baseExists = $false
			break
		}
		Assert-AncestorAcl $parent $current
		if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) {
			throw ('Refusing a reparse point in the storage path: ' + $current)
		}
		if ($index -eq $segments.Length - 1) {
			if (($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) {
				throw 'The account storage base must be a directory.'
			}
			Assert-PrivateAcl $current
		} else {
			if (($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) {
				throw 'An account storage path ancestor is not a directory.'
			}
		}
	}
	return $baseExists
}

function Assert-AncestorAcl([string] $Value, [string] $ExistingChild = '') {
	$acl = Get-Acl -LiteralPath $Value
	$ownerSid = Get-Sid $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
	if ($ownerSid -notin $trustedOwnerSids -and $ownerSid -ne (Get-CurrentSid)) {
		throw ('An untrusted identity owns an ancestor of private storage: ' + $Value)
	}
	foreach ($rule in $acl.Access) {
		if ($rule.AccessControlType -ne $accessControlType::Allow) {
			continue
		}
		$sid = Get-Sid $rule.IdentityReference
		if ($sid -in $trustedWriteSids -or $sid -eq (Get-CurrentSid)) {
			continue
		}
		$rights = Get-NormalizedRights $rule.FileSystemRights
		if (-not [string]::IsNullOrWhiteSpace($ExistingChild)) {
			if ($rule.PropagationFlags -band $propagationFlags::InheritOnly) {
				continue
			}
			$cannotReplaceChild = [int64] $fileSystemRights::Delete -bor
				[int64] $fileSystemRights::DeleteSubdirectoriesAndFiles -bor
				[int64] $fileSystemRights::ChangePermissions -bor
				[int64] $fileSystemRights::TakeOwnership -bor [int64] 0x10000000
			if (($rights -band $cannotReplaceChild) -eq 0) {
				continue
			}
		}
		$explicitRights = $rights -band [int64] 0x0FFFFFFF
		$untrustedGenericWrite = [int64] 0x50000000
		if (($explicitRights -band (-bnot $safeReadMask)) -ne 0 -or
			($rights -band $untrustedGenericWrite) -ne 0) {
			throw ('An ancestor grants an untrusted write-capable ACL: ' + $Value)
		}
	}
}

function Assert-NoUntrustedInheritedAllows([string] $Parent) {
	$acl = Get-Acl -LiteralPath $Parent
	foreach ($rule in $acl.Access) {
		if ($rule.AccessControlType -ne $accessControlType::Allow) {
			continue
		}
		$sid = Get-Sid $rule.IdentityReference
		if ($sid -in $trustedWriteSids -or $sid -eq (Get-CurrentSid)) {
			continue
		}
		if (($rule.InheritanceFlags -band ($inheritanceFlags::ContainerInherit -bor $inheritanceFlags::ObjectInherit)) -ne 0) {
			throw ('An ancestor grants an untrusted inheritable ACL: ' + $Parent)
		}
	}
}

function Assert-ExistingPathAncestors([string] $Target, [string] $StopAt = '') {
	$child = Get-NormalPath $Target
	while ($true) {
		$childItem = Get-Item -LiteralPath $child -Force
		if ($childItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
			throw ('Refusing a reparse point in the storage path: ' + $child)
		}
		$parentInfo = [System.IO.Directory]::GetParent($child)
		if ($null -eq $parentInfo -or $parentInfo.FullName -eq $child) {
			break
		}
		$parent = Get-NormalPath $parentInfo.FullName
		$parentItem = Get-Item -LiteralPath $parent -Force
		if (-not $parentItem.PSIsContainer -or ($parentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
			throw 'A storage path ancestor is not a regular directory.'
		}
		Assert-AncestorAcl $parent $child
		if (-not [string]::IsNullOrWhiteSpace($StopAt) -and
			[System.StringComparer]::OrdinalIgnoreCase.Equals($parent, (Get-NormalPath $StopAt))) {
			break
		}
		$child = $parent
	}
}

function Assert-PrivateAcl([string] $Value) {
	$acl = Get-Acl -LiteralPath $Value
	$ownerSid = Get-Sid $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
	if ($ownerSid -notin $trustedOwnerSids -and $ownerSid -ne (Get-CurrentSid)) {
		throw ('An untrusted identity owns private storage: ' + $Value)
	}
	foreach ($rule in $acl.Access) {
		$sid = Get-Sid $rule.IdentityReference
		if ($rule.AccessControlType -eq $accessControlType::Allow -and $sid -notin $trustedWriteSids -and $sid -ne (Get-CurrentSid)) {
			throw ('Private storage grants ACL access to an untrusted identity: ' + $Value)
		}
	}
}

function Assert-PrivateFilePath([string] $Value) {
	$targetPath = Get-NormalPath $Value
	Assert-NoReparseAncestors $targetPath
	$item = Get-Item -LiteralPath $targetPath -Force
	if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
		throw 'The ownership map must be a regular file.'
	}
	Assert-PrivateAcl $targetPath
	$parent = [System.IO.Directory]::GetParent($targetPath)
	if ($null -eq $parent) {
		throw 'The ownership map must have a verified parent directory.'
	}
	$current = Get-NormalPath $parent.FullName
	$profile = Get-NormalPath ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile))
	$checkThroughProfile = [System.StringComparer]::OrdinalIgnoreCase.Equals($targetPath, $profile) -or
		(Test-PathBelow $targetPath $profile)
	Assert-ExistingPathAncestors $targetPath $(if ($checkThroughProfile) { $profile } else { '' })
}

function Assert-StoragePath([string] $Target, [string] $Boundary) {
	$targetPath = Get-NormalPath $Target
	$boundaryPath = Get-NormalPath $Boundary
	$targetIsPrivate = [System.StringComparer]::OrdinalIgnoreCase.Equals($targetPath, $boundaryPath) -or (Test-PathBelow $targetPath $boundaryPath)
	$targetIsAncestor = Test-PathBelow $boundaryPath $targetPath
	if (-not $targetIsPrivate -and -not $targetIsAncestor) {
		throw 'The checked path is outside the account storage boundary.'
	}
	Assert-NoReparseAncestors $targetPath
	if ($targetIsPrivate) {
		$current = $targetPath
		while ($true) {
			Assert-PrivateAcl $current
			if ([System.StringComparer]::OrdinalIgnoreCase.Equals($current, $boundaryPath)) {
				break
			}
			$parent = [System.IO.Directory]::GetParent($current)
			if ($null -eq $parent -or $parent.FullName -eq $current) {
				throw 'The private account storage boundary is missing from the checked path.'
			}
			$current = Get-NormalPath $parent.FullName
		}
		Assert-ExistingPathAncestors $boundaryPath
		return
	}

	# Check the existing ancestor named by $Target and each intermediate path down to the boundary.
	Assert-ExistingPathAncestors $boundaryPath $targetPath
}

function Sync-StorageDirectory([string] $Target, [string] $Boundary) {
	Assert-StoragePath $Target $Boundary
	$item = Get-Item -LiteralPath (Get-NormalPath $Target) -Force
	if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
		throw 'Only a verified regular directory can be flushed.'
	}
	Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class PetujaDirectoryFlush {
    [StructLayout(LayoutKind.Sequential)]
    public struct ByHandleFileInformation {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern SafeFileHandle CreateFile(
        string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandleFileInformation info);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool FlushFileBuffers(SafeFileHandle handle);
}
'@
	$flags = [uint32] 0x02000000 -bor [uint32] 0x00200000
	$handle = [PetujaDirectoryFlush]::CreateFile((Get-NormalPath $Target), [uint32] 0x40000000,
		[uint32] 0x00000007, [IntPtr]::Zero, [uint32] 3, $flags, [IntPtr]::Zero)
	if ($handle.IsInvalid) {
		throw [System.ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
	}
	try {
		$information = [PetujaDirectoryFlush+ByHandleFileInformation]::new()
		if (-not [PetujaDirectoryFlush]::GetFileInformationByHandle($handle, [ref] $information) -or
			($information.FileAttributes -band [uint32] 0x00000010) -eq 0 -or
			($information.FileAttributes -band [uint32] 0x00000400) -ne 0) {
			throw 'The opened handle is not the verified regular directory.'
		}
		if (-not [PetujaDirectoryFlush]::FlushFileBuffers($handle)) {
			throw [System.ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
		}
	} finally {
		$handle.Dispose()
	}
}

function Get-CurrentSid {
	return [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

function Assert-ProfileParent([string] $Root) {
	$profile = Get-NormalPath ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile))
	$rootPath = Get-NormalPath $Root
	$parentPath = Get-NormalPath ([System.IO.Directory]::GetParent($rootPath).FullName)
	if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals($parentPath, $profile)) {
		throw 'The local demo root must be a direct child of the current user profile.'
	}
	Assert-NoReparseAncestors $profile
	Assert-AncestorAcl $profile
}

function Assert-DemoRootAcl([string] $Root) {
	$rootPath = Get-NormalPath $Root
	Assert-ProfileParent $rootPath
	$item = Get-Item -LiteralPath $rootPath -Force
	if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
		throw 'The local demo root must be a regular directory.'
	}
	$acl = Get-Acl -LiteralPath $rootPath
	if (-not $acl.AreAccessRulesProtected) {
		throw 'The local demo root must have a protected DACL.'
	}
	$expected = @((Get-CurrentSid), 'S-1-5-18', 'S-1-5-32-544') | Sort-Object -Unique
	$actual = @()
	foreach ($rule in $acl.Access) {
		$sid = Get-Sid $rule.IdentityReference
		if ($rule.AccessControlType -ne $accessControlType::Allow -or $rule.IsInherited -or $rule.FileSystemRights -ne $fileSystemRights::FullControl -or
			$rule.InheritanceFlags -ne ($inheritanceFlags::ContainerInherit -bor $inheritanceFlags::ObjectInherit) -or
			$rule.PropagationFlags -ne $propagationFlags::None -or $sid -notin $expected) {
			throw 'The local demo root DACL does not match the required private ACL.'
		}
		$actual += $sid
	}
	$actual = @($actual | Sort-Object -Unique)
	if ($actual.Count -ne $expected.Count -or (Compare-Object $expected $actual)) {
		throw 'The local demo root DACL is missing a required trusted principal.'
	}
	if ((Get-Sid $acl.GetOwner([System.Security.Principal.SecurityIdentifier])) -ne (Get-CurrentSid)) {
		throw 'The current user must own the local demo root.'
	}
}

function Set-DemoRootAcl([string] $Root) {
	$rootPath = Get-NormalPath $Root
	$acl = Get-Acl -LiteralPath $rootPath
	$acl.SetAccessRuleProtection($true, $false)
	$acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new((Get-CurrentSid)))
	$acl.Access | ForEach-Object { [void] $acl.RemoveAccessRuleSpecific($_) }
	$inherit = $inheritanceFlags::ContainerInherit -bor $inheritanceFlags::ObjectInherit
	foreach ($sidText in @((Get-CurrentSid), 'S-1-5-18', 'S-1-5-32-544')) {
		$sid = [System.Security.Principal.SecurityIdentifier]::new($sidText)
		$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
			$sid,
			$fileSystemRights::FullControl,
			$inherit,
			$propagationFlags::None,
			$accessControlType::Allow
		)
		[void] $acl.AddAccessRule($rule)
	}
	Set-Acl -LiteralPath $rootPath -AclObject $acl
}

try {
	$result = 'OK'
	switch ($Operation) {
		'VerifyStorageBasePath' {
			if (-not (Assert-StorageBasePath $Path)) {
				$result = 'MISSING'
			}
		}
		'PrepareDemoRoot' {
			$rootPath = Get-NormalPath $Path
			Assert-ProfileParent $rootPath
			if (-not (Test-Path -LiteralPath $rootPath)) {
				[void] [System.IO.Directory]::CreateDirectory($rootPath)
				Set-DemoRootAcl $rootPath
				$result = 'CREATED'
			} else {
				$result = 'EXISTS'
			}
			Assert-DemoRootAcl $rootPath
		}
		'VerifyDemoRoot' {
			Assert-DemoRootAcl $Path
		}
		'VerifyDemoTree' {
			Assert-DemoRootAcl $Path
			Assert-PrivateAcl $Path
			$directories = [System.Collections.Generic.Stack[string]]::new()
			$directories.Push((Get-NormalPath $Path))
			while ($directories.Count -gt 0) {
				$currentDirectory = $directories.Pop()
				foreach ($item in [System.IO.Directory]::EnumerateFileSystemEntries($currentDirectory, '*', [System.IO.SearchOption]::TopDirectoryOnly)) {
					$entry = Get-Item -LiteralPath $item -Force
					if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
						throw ('Refusing a reparse point in the local demo tree: ' + $item)
					}
					Assert-PrivateAcl $item
					if ($entry.PSIsContainer) {
						$directories.Push($item)
					}
				}
			}
		}
		'VerifyStoragePath' {
			if ([string]::IsNullOrWhiteSpace($PrivateBase)) {
				throw 'The account storage boundary is required.'
			}
			Assert-StoragePath $Path $PrivateBase
		}
		'VerifyStoragePathOrMissing' {
			if ([string]::IsNullOrWhiteSpace($PrivateBase)) {
				throw 'The account storage boundary is required.'
			}
			try {
				[void] [System.IO.File]::GetAttributes((Get-NormalPath $Path))
			} catch {
				$cause = $_.Exception
				while ($null -ne $cause -and
					$cause -isnot [System.IO.FileNotFoundException] -and
					$cause -isnot [System.IO.DirectoryNotFoundException]) {
					$cause = $cause.InnerException
				}
				if ($cause -isnot [System.IO.FileNotFoundException] -and
					$cause -isnot [System.IO.DirectoryNotFoundException]) {
					throw
				}
				$parent = [System.IO.Directory]::GetParent((Get-NormalPath $Path))
				if ($null -eq $parent) {
					throw
				}
				Assert-StoragePath $parent.FullName $PrivateBase
				$result = 'MISSING'
				break
			}
			Assert-StoragePath $Path $PrivateBase
		}
		'VerifyPrivateFile' {
			Assert-PrivateFilePath $Path
		}
		'SyncDirectory' {
			if ([string]::IsNullOrWhiteSpace($PrivateBase)) {
				throw 'The account storage boundary is required.'
			}
			Sync-StorageDirectory $Path $PrivateBase
		}
	}
	[Console]::Out.WriteLine($result)
	exit 0
} catch {
	[Console]::Error.WriteLine($_.Exception.Message)
	exit 1
}
