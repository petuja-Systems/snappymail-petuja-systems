<?php
declare(strict_types=1);
namespace SnappyMail\PGP {
	// This fixture must never start GPG or inspect the real process HOME.
	class GnuPG {
		public static function getInstance(string $home) { throw new \FixturePgpHome($home); }
	}
}
namespace {
use RainLoop\Providers\Storage\Enumerations\StorageType as S;
use SnappyMail\Storage\AccountPath;
class FixturePgpHome extends \RuntimeException {}
$root = dirname(__DIR__, 2);
$libraries = $root.'/snappymail/v/0.0.0/app/libraries/';
spl_autoload_register(function ($class) use ($libraries) {
	$name = str_replace('\\', '/', $class).'.php';
	foreach ([$name, strtolower($name)] as $file) {
		if (is_file($libraries.$file)) { require_once $libraries.$file; return; }
	}
});
class FixtureMain extends \RainLoop\Model\MainAccount {
	public function __construct(private string $email) {}
	public function Email(): string { return $this->email; }
}
class FixtureChild extends \RainLoop\Model\AdditionalAccount {
	public function __construct(private string $parent, private string $email) {}
	public function Email(): string { return $this->email; }
	public function ParentEmail(): string { return $this->parent; }
}
function yes($condition): void { if (!$condition) { throw new RuntimeException('Synthetic storage assertion failed'); } }
function rejected(callable $call): bool { try { $call(); } catch (Throwable $e) { return true; } return false; }
function put(string $path, string $value = 'synthetic-data'): void {
	if (!is_dir(dirname($path))) { mkdir(dirname($path), 0700, true); }
	file_put_contents($path, $value); chmod($path, 0600);
}
$temporary = $argv[1] ?? '';
$mode = $argv[2] ?? '';
yes($temporary && is_dir($temporary));
$temporary = realpath($temporary);
$base = $temporary.'/storage';
if ('windows-reparse-base' === $mode) {
	yes('Windows' === PHP_OS_FAMILY);
	$reparseBase = $argv[3] ?? '';
	yes('' !== $reparseBase && rejected(fn() => new AccountPath($reparseBase)));
	echo json_encode(['passed'=>true,'mode'=>$mode], JSON_THROW_ON_ERROR);
	exit(0);
}
if ('windows-reject' === $mode) {
	yes('Windows' === PHP_OS_FAMILY);
	yes(rejected(fn() => new AccountPath($base)));
	echo json_encode(['passed'=>true,'mode'=>$mode], JSON_THROW_ON_ERROR);
	exit(0);
}
$paths = new AccountPath($base);
$storage = new \RainLoop\Providers\Storage\FileStorage($base);
$local = new \RainLoop\Providers\Storage\FileStorage($base, true);
$files = new \RainLoop\Providers\Files\FileStorage($base);
$main = 'reader+notes@example.test';
$other = 'reader-notes@example.test';
$legacy = $base.'/example.test/reader-notes';
$map = ['authoritative_ownership'=>true, 'accounts'=>[
	['identity'=>$main, 'source'=>'example.test/reader-notes', 'children'=>[
		['identity'=>'child+notes@example.test', 'source'=>'child-notes@example.test']
	]]
]];
if (str_starts_with($mode, 'dry-run-prepare')) {
	mkdir($base.'/example.test/reader-notes',0700,true);
	put($legacy.'/settings','synthetic-account-settings');
	put($legacy.'/child-notes@example.test/settings','synthetic-child-settings');
	$dryMap=$map;
	if ('dry-run-prepare-invalid' === $mode) {
		$dryMap['accounts'][0]['source']='example.test/missing';
	}
	file_put_contents($temporary.'/authoritative.json',json_encode($dryMap,JSON_THROW_ON_ERROR));
	chmod($temporary.'/authoritative.json',0600);
	if (str_starts_with($mode,'dry-run-prepare-resume')) {
		mkdir($base.'-v2',0700);
		put($base.'-v2/.pending',''); chmod($base.'-v2/.pending',0600);
		put($base.'-v2/.identity-'.str_repeat('c',24),'synthetic-interrupted-metadata');
		chmod($base.'-v2/.identity-'.str_repeat('c',24),0600);
		if ('dry-run-prepare-resume-mismatch' === $mode) {
			put($base.'-v2/.identity.json','{}'); chmod($base.'-v2/.identity.json',0600);
		}
	}
} elseif ('read-only' === $mode) {
	$value = null;
	yes(false === $storage->Inspect($main,S::CONFIG,'two_factor',$value));
	yes($storage->Get($main,S::SESSION,'unknown','absent') === 'absent');
	yes(false === $storage->AcquireLock($main,S::SIGN_ME,'account'));
	yes(!$storage->Clear($main,S::CONFIG,'unknown'));
	yes(false === $storage->Revoke($main,S::SESSION,'unknown'));
	yes(!$files->FileExists(new FixtureMain($main),'unknown'));
	$storage->GenerateFilePath(new FixtureMain($main),S::ROOT);
	yes(!file_exists($base.'-v2/.identity.json'));
	yes(!file_exists($base.'-v2/'.AccountPath::Identity($main)));
	yes(!is_dir($base.'/.signme-locks'));
	yes($storage->Put($main,S::SESSION,'owned','synthetic-session'));
	$before=file_get_contents($base.'-v2/.identity.json');
	$child=new FixtureChild($main,'new-child@example.test');
	yes($local->Get($child,S::CONFIG,'identities_order','default') === 'default');
	yes(!$files->FileExists($child,'unknown'));
	yes(file_get_contents($base.'-v2/.identity.json') === $before);
	yes(!is_dir($base.'-v2/'.AccountPath::Identity($main).'/.accounts-v2'));
	put($base.'-v2/'.AccountPath::Identity($main).'/.accounts-v2/'.AccountPath::Identity($main,'unreceipted@example.test').'/marker','preserved');
	yes(rejected(fn()=>$local->Get(new FixtureChild($main,'unreceipted@example.test'),S::CONFIG,'settings','default')));
} elseif ('deletion-failure' === $mode) {
	yes(!function_exists('unlink'));
	yes(rejected(fn()=>$paths->Delete($main,'missing@example.test')));
	yes($storage->Get($main,S::CONFIG,'two_factor') === 'synthetic-enabled-factor');
	yes(rejected(fn()=>$storage->DeleteStorage($main)));
	yes(rejected(fn()=>$storage->Get($main,S::CONFIG,'two_factor','missing')));
	yes(rejected(fn()=>$paths->Delete($main,'child+notes@example.test')));
	$state=json_decode(file_get_contents($base.'-v2/.identity.json'),true);
	yes($state['owners'][AccountPath::Identity($main)]['deleting'] === ['child'=>'']);
	put($base.'-v2/.identity-'.str_repeat('e',24),'interrupted-private-metadata');
} elseif ('deletion-resume' === $mode) {
	yes($storage->DeleteStorage($main));
	yes($storage->Get($main,S::CONFIG,'two_factor','missing') === 'missing');
	yes(!file_exists($base.'-v2/.identity-'.str_repeat('e',24)));
	yes(rejected(fn()=>$paths->Resolve($other)));
} elseif ('initial-registry-recovery' === $mode) {
	mkdir($base,0700); mkdir($base.'-v2',0700);
	$temp=$base.'-v2/.identity-'.str_repeat('d',24); put($temp,'interrupted-initial-metadata');
	yes(rejected(fn()=>$paths->Resolve($main)));
	$empty=['authoritative_ownership'=>true,'accounts'=>[]];
	if ('Windows' !== PHP_OS_FAMILY) {
		chmod($temp,0644); yes(rejected(fn()=>$paths->Adopt($empty))); chmod($temp,0600);
	}
	$unknown=$base.'-v2/unknown-preserved'; put($unknown,'not-a-registry-temp');
	yes(rejected(fn()=>$paths->Adopt($empty))); yes(file_get_contents($unknown) === 'not-a-registry-temp');
	unlink($unknown);
	$paths->Adopt($empty); yes(!file_exists($temp));
	yes(str_contains($paths->Resolve($main),'storage-v2/'));
} elseif ('leaf-links' === $mode) {
	$one=new FixtureMain($main); $two=new FixtureMain($other);
	$storage->Put($main,S::SESSION,'fixture','own-session');
	$storage->Put($other,S::SESSION,'fixture','other-session');
	$a=$storage->GenerateFilePath($main,S::SESSION).'fixture';
	$b=$storage->GenerateFilePath($other,S::SESSION).'fixture';
	if ('Windows' !== PHP_OS_FAMILY) {
		unlink($a); symlink($b,$a);
		yes(rejected(fn()=>$storage->Get($main,S::SESSION,'fixture')));
		yes(rejected(fn()=>$storage->Put($main,S::SESSION,'fixture','replacement')));
		yes($storage->Get($other,S::SESSION,'fixture') === 'other-session');
		unlink($a);
	}
	if (file_exists($a) || is_link($a)) { unlink($a); }
	link($b,$a);
	yes(rejected(fn()=>$storage->Get($main,S::SESSION,'fixture'))); unlink($a);
	if ('Windows' !== PHP_OS_FAMILY) {
		$target=$files->GenerateLocalFullFileName($two,'attachment'); put($target,'owned-attachment');
		$source=$files->GenerateLocalFullFileName($one,'attachment'); symlink($target,$source);
		yes(rejected(fn()=>$files->GetFile($one,'attachment')));
		$stream=fopen('php://temp','w+b'); fwrite($stream,'replacement'); rewind($stream);
		yes(rejected(fn()=>$files->PutFile($one,'attachment',$stream))); fclose($stream);
		yes(file_get_contents($target) === 'owned-attachment');
	}
} elseif (str_starts_with($mode,'allocation-')) {
	$child='child@example.test'; $id=AccountPath::Identity($main);
	$isChild=str_contains($mode,'child');
	$rootPath=rtrim($paths->Resolve($main),'/');
	$path=$isChild ? rtrim($paths->Resolve($main,$child),'/') : $rootPath;
	$target=$isChild ? AccountPath::Identity($main,$child) : $id;
	$parent=dirname($path); $parentStat=lstat($parent);
	$metadata=$base.'-v2/.identity.json'; $state=json_decode(file_get_contents($metadata),true);
	$intent=['identity'=>$isChild ? $child : $main,
		'allocating'=>['target'=>$target,'parent'=>['dev'=>$parentStat['dev'],'ino'=>$parentStat['ino']]]];
	if ($isChild) { $state['owners'][$id]['children'][$target]=$intent; }
	else { $intent['children']=[]; $state['owners'][$id]=$intent; }
	put($metadata,json_encode($state,JSON_THROW_ON_ERROR));
	if (str_ends_with($mode,'absent')) { rmdir($path); }
	if (str_ends_with($mode,'dirty')) { put($path.'/unexpected','preserved'); }
	put($base.'-v2/.identity-'.str_repeat('c',24),'interrupted-private-metadata');
	if (str_ends_with($mode,'dirty')) {
		yes(rejected(fn()=>$paths->Resolve($main,$isChild ? $child : '')));
		yes(file_get_contents($path.'/unexpected') === 'preserved');
	} else {
		yes($paths->Resolve($main,$isChild ? $child : '') === $path.'/');
		$recovered=json_decode(file_get_contents($metadata),true);
		$record=$isChild ? $recovered['owners'][$id]['children'][$target] : $recovered['owners'][$id];
		yes(!isset($record['allocating']) && isset($record['dev'],$record['ino']));
		yes(!file_exists($base.'-v2/.identity-'.str_repeat('c',24)));
	}
} elseif (str_starts_with($mode,'gnupg-')) {
	putenv('HOME='.$temporary.'/home');
	$_SERVER['HOME']=$temporary.'/home';
	class FixturePgpActions {
		use \RainLoop\Actions\Pgp;
		public function __construct(private $storage, private $account) {}
		public function getMainAccountFromToken() { return $this->account; }
		public function StorageProvider() { return $this->storage; }
	}
	$home=rtrim($storage->GenerateFilePath($main,S::ROOT,true),'/').'/.gnupg';
	if (!is_dir($home)) { mkdir($home,0700); }
	$aliasDirectory=sys_get_temp_dir().'/snappymail';
	if (!is_dir($aliasDirectory)) { mkdir($aliasDirectory,0700); }
	$alias=$aliasDirectory.'/'.md5($home);
	if ('gnupg-wrong-alias-prepare' === $mode) {
		mkdir($temporary.'/unowned',0700);
		put($temporary.'/unowned/marker','preserved');
		echo json_encode(['alias'=>$alias], JSON_THROW_ON_ERROR);
		exit(0);
	}
	if ('gnupg-wrong-alias' === $mode) {
		if (!is_dir($temporary.'/unowned')) { mkdir($temporary.'/unowned',0700); }
		put($temporary.'/unowned/marker','preserved');
		if ('Windows' === PHP_OS_FAMILY) {
			yes(is_dir($alias));
		} else {
			symlink($temporary.'/unowned',$alias);
		}
	} elseif ('gnupg-external-home' === $mode) {
		put($temporary.'/home/.gnupg/'.sha1($main).'/marker','preserved');
	} elseif ('gnupg-server-home' === $mode) {
		$_SERVER['HOME']=$temporary.'/server-home';
		put($temporary.'/server-home/.gnupg/'.sha1($main).'/marker','preserved');
	} elseif ('gnupg-unprivate-alias' === $mode) {
		chmod($aliasDirectory,0755);
	}
	$actions=new FixturePgpActions($storage,new FixtureMain($main));
	$reached=null;
	try { $actions->GnuPG(); } catch (FixturePgpHome $expected) { $reached=$expected->getMessage(); }
	catch (Throwable $expected) { yes('gnupg-safe' !== $mode); }
	if ('gnupg-safe' === $mode) {
		yes($reached === $alias); yes(readlink($alias) === $home);
	} else {
		yes(null === $reached);
		if ('gnupg-wrong-alias' === $mode) { yes(file_get_contents($temporary.'/unowned/marker') === 'preserved'); }
		if ('gnupg-external-home' === $mode) { yes(file_get_contents($temporary.'/home/.gnupg/'.sha1($main).'/marker') === 'preserved'); }
		if ('gnupg-server-home' === $mode) { yes(file_get_contents($temporary.'/server-home/.gnupg/'.sha1($main).'/marker') === 'preserved'); }
	}
} elseif ('race-write' === $mode) {
	$writer = new class($base, $temporary) extends \RainLoop\Providers\Storage\FileStorage {
		public function __construct(string $base, private string $barrier) { parent::__construct($base); }
		protected function generateFileName($account, int $type, string $key, bool $mkdir = false): string {
			$path = parent::generateFileName($account,$type,$key,$mkdir);
			file_put_contents($this->barrier.'/write-resolved','ready');
			$deadline=microtime(true)+15;
			while (!is_file($this->barrier.'/release-write')) {
				if (microtime(true)>$deadline) { throw new RuntimeException('Synthetic write barrier timed out'); }
				usleep(10000);
			}
			return $path;
		}
	};
	yes($writer->Put($main,S::CONFIG,'race-state','synthetic-before-clear'));
} elseif ('race-read' === $mode) {
	$storage->Put($main,S::SESSION,'race-session','synthetic-live-session');
	$record=$storage->GenerateFilePath($main,S::SESSION).'race-session';
	touch($record,time()-3600*24*40);
	$reader = new class($base, $temporary) extends \RainLoop\Providers\Storage\FileStorage {
		public function __construct(string $base, private string $barrier) { parent::__construct($base); }
		protected function generateFileName($account, int $type, string $key, bool $mkdir = false): string {
			$path=parent::generateFileName($account,$type,$key,$mkdir);
			file_put_contents($this->barrier.'/read-resolved','ready');
			$deadline=microtime(true)+15;
			while (!is_file($this->barrier.'/release-read')) {
				if (microtime(true)>$deadline) { throw new RuntimeException('Synthetic read barrier timed out'); }
				usleep(10000);
			}
			return $path;
		}
	};
	yes($reader->Get($main,S::SESSION,'race-session') === 'synthetic-live-session');
} elseif ('race-gc' === $mode) {
	put($temporary.'/gc-started'); $storage->GC();
	yes($storage->Get($main,S::SESSION,'race-session') === 'synthetic-live-session');
	put($temporary.'/gc-completed');
} elseif ('race-delete' === $mode) {
	put($temporary.'/delete-started');
	yes($storage->DeleteStorage($main));
	yes($storage->Get($main,S::CONFIG,'race-state','absent') === 'absent');
	put($temporary.'/delete-completed');
} else if ('identity' === $mode) {
	yes(AccountPath::Identity($main) !== AccountPath::Identity($other));
	yes(AccountPath::Identity('A@example.test') !== AccountPath::Identity('a@example.test'));
	yes(AccountPath::Identity($main, $other) !== AccountPath::Identity($other, $main));
	yes(preg_match('/^[a-f0-9]{64}$/', AccountPath::Identity($main)) === 1);
	foreach (["bad\n@example.test", '', 'example.test', '@example.test'] as $bad) {
		yes(rejected(fn()=>AccountPath::Identity($bad)));
	}
} elseif ('fresh' === $mode) {
	$a = $paths->Resolve($main);
	$b = $paths->Resolve($other);
	yes($a !== $b && str_contains($a, 'storage-v2/'));
	if ('Windows' === PHP_OS_FAMILY) {
		// The v2 namespace is a sibling of the legacy root; both inherit the private boundary.
		yes(is_dir($base) && is_dir($base.'-v2'));
	}
	$value = null;
	yes(false === $storage->Inspect($main,S::CONFIG,'two_factor',$value));
	foreach ([S::CONFIG,S::SESSION,S::SIGN_ME,S::PGP,S::ROOT] as $type) {
		yes($storage->Put($main,$type,'fixture','main'));
		yes($storage->Get($other,$type,'fixture','absent') === 'absent');
	}
	$child = new FixtureChild($main, $other);
	$second = new FixtureChild($other, $other);
	yes($local->Put($child,S::CONFIG,'settings','child'));
	yes($local->Get($second,S::CONFIG,'settings','absent') === 'absent');
	yes($storage->GenerateFilePath($child,S::ROOT) === $a);
	yes($storage->GenerateFilePath($child,S::SESSION) === $storage->GenerateFilePath($main,S::SESSION));
	yes($local->GenerateFilePath($child,S::CONFIG) !== $local->GenerateFilePath($second,S::CONFIG));
	$one = $files->GenerateLocalFullFileName($child,'upload');
	$two = $files->GenerateLocalFullFileName($second,'upload');
	yes($one !== $two); put($one,'attachment'); yes(!$files->FileExists($second,'upload'));
	foreach (['.cryptkey','.pgp/key','.smime/cert','.gnupg/key','AddressBook.sqlite'] as $name) {
		put($a.$name); yes(!file_exists($b.$name));
	}
	yes((new AccountPath($base))->Resolve($main) === $a);
} elseif ('windows-absent' === $mode) {
	yes('Windows' === PHP_OS_FAMILY);
	$value = null;
	yes(false === $storage->Inspect($main,S::CONFIG,'two_factor',$value));
	yes(is_dir($base) && is_dir($base.'-v2'));
} elseif ('ambiguous' === $mode) {
	put($legacy.'/two_factor','synthetic-enabled-factor');
	yes(rejected(fn()=>$storage->Get($main,S::CONFIG,'two_factor','missing')));
	yes(rejected(fn()=>$storage->Get($other,S::CONFIG,'two_factor','missing')));
	yes(rejected(fn()=>$storage->Put($main,S::SESSION,'auth-fixture','authority')));
	yes(file_get_contents($legacy.'/two_factor') === 'synthetic-enabled-factor');
	yes(!file_exists($base.'-v2/'.AccountPath::Identity($main)));
	yes(rejected(fn()=>$storage->GC()));
	yes(rejected(fn()=>$files->GC()));
} elseif (in_array($mode,['legacy','deletion','pending','replacement','invalid','locking','recovery','unknown-child','reattest','deletion-prepare','nofsync-adopt'],true)) {
	put($legacy.'/settings','owner-data');
	put($legacy.'/two_factor','synthetic-enabled-factor');
	put($legacy.'/.sessions/session','synthetic-session');
	put($legacy.'/.sign_me/lineage','synthetic-lineage');
	put($legacy.'/.pgp/key','synthetic-pgp');
	put($legacy.'/.smime/cert','synthetic-smime');
	put($legacy.'/.gnupg/key','synthetic-gpg');
	put($legacy.'/AddressBook.sqlite','synthetic-contacts');
	put($legacy.'/child-notes@example.test/settings','child-data');
	put($legacy.'/child-notes@example.test/.files/upload','synthetic-attachment');
	$before = lstat($legacy);
	if ('nofsync-adopt' === $mode) {
		yes(rejected(fn()=>$paths->Adopt($map)));
		yes(file_get_contents($legacy.'/two_factor') === 'synthetic-enabled-factor');
	} elseif ('invalid' === $mode) {
		$bad = $map; $bad['accounts'][]=$map['accounts'][0]; yes(rejected(fn()=>$paths->Adopt($bad)));
		$bad = $map; unset($bad['accounts'][0]['children']); yes(rejected(fn()=>$paths->Adopt($bad)));
		$bad = $map; $bad['accounts'][0]['source']='../reader'; yes(rejected(fn()=>$paths->Adopt($bad)));
		if ('Windows' !== PHP_OS_FAMILY) {
			put($temporary.'/outside');
			symlink($temporary.'/outside',$legacy.'/alias'); yes(rejected(fn()=>$paths->Adopt($map))); unlink($legacy.'/alias');
		}
		link($legacy.'/settings',$legacy.'/hardlink'); yes(rejected(fn()=>$paths->Adopt($map))); unlink($legacy.'/hardlink');
		put($base.'/cfg/old/record'); yes(rejected(fn()=>$paths->Adopt($map)));
		yes(file_get_contents($legacy.'/settings') === 'owner-data');
		yes(!file_exists($base.'-v2/.identity.json'));
	} elseif ('locking' === $mode) {
		mkdir($base.'/.signme-locks',0700);
		$lock=fopen($base.'/.signme-locks/fixture.lock','c+b'); flock($lock,LOCK_EX);
		yes(rejected(fn()=>$paths->Adopt($map)));
		yes(!file_exists($base.'-v2/.identity.json'));
		flock($lock,LOCK_UN); fclose($lock);
		$paths->Adopt($map);
		yes($storage->Get($main,S::CONFIG,'settings') === 'owner-data');
	} else {
		$paths->Adopt($map);
		yes(lstat($legacy)['ino'] === $before['ino']);
		yes($paths->Resolve($main) === $legacy.'/');
		yes($storage->Get($main,S::CONFIG,'two_factor') === 'synthetic-enabled-factor');
		$value = null;
		yes(true === $storage->Inspect($main,S::CONFIG,'two_factor',$value));
		yes($value === 'synthetic-enabled-factor');
		yes(rejected(fn()=>$paths->Resolve($other)));
		$child = new FixtureChild($main,'child+notes@example.test');
		yes($local->Get($child,S::CONFIG,'settings') === 'child-data');
		yes(rejected(fn()=>$paths->Resolve($main,'child-notes@example.test')));
		if (!in_array($mode,['recovery','reattest'],true)) {
			yes(str_contains($paths->Resolve($main,'fresh@example.test'),'/.accounts-v2/'));
		}
		if ('unknown-child' === $mode) {
			put($legacy.'/unassigned@example.test/settings','preserved-unassigned');
			yes(rejected(fn()=>$storage->Get($main,S::CONFIG,'settings')));
			yes(rejected(fn()=>$storage->DeleteStorage($main)));
			yes(file_get_contents($legacy.'/unassigned@example.test/settings') === 'preserved-unassigned');

		} elseif ('reattest' === $mode) {
			$backup=$temporary.'/preserved-legacy'; rename($legacy,$backup); mkdir($legacy,0700);
			foreach (new DirectoryIterator($backup) as $item) {
				if (!$item->isDot()) { rename($item->getPathname(),$legacy.'/'.$item->getFilename()); }
			}
			rmdir($backup);
			yes(rejected(fn()=>$paths->Resolve($main)));
			$bad=$map; $bad['accounts'][0]['identity']=$other;
			yes(rejected(fn()=>$paths->Reattest($bad)));
			$paths->Reattest($map);
			yes($storage->Get($main,S::CONFIG,'two_factor') === 'synthetic-enabled-factor');
		} elseif ('recovery' === $mode) {
			put($base.'-v2/.pending','');
			put($base.'-v2/.identity-'.str_repeat('a',24),'interrupted-private-metadata');
			yes(rejected(fn()=>$paths->Resolve($main)));
			$paths->Adopt($map,true);
			yes(!file_exists($base.'-v2/.identity-'.str_repeat('a',24)));
			yes($storage->Get($main,S::CONFIG,'two_factor') === 'synthetic-enabled-factor');
		} elseif ('deletion' === $mode) {
			$childPath=$local->GenerateFilePath($child,S::CONFIG);
			$childInode=lstat(rtrim($childPath,'/'))['ino'];
			yes($storage->DeleteStorage($main));
			yes(lstat($legacy)['ino'] === $before['ino']);
			yes(lstat(rtrim($childPath,'/'))['ino'] === $childInode);
			yes(!file_exists($legacy.'/two_factor'));
			yes(!file_exists($legacy.'/.pgp/key'));
			yes(rejected(fn()=>$paths->Resolve($other)));
			yes(rejected(fn()=>$paths->Resolve($main,'child-notes@example.test')));
		} elseif ('pending' === $mode) {
			// A pending publication must never expose missing/partial state.
			put($base.'-v2/.pending','');
			yes(rejected(fn()=>$paths->Resolve($main)));
			// Recovery reattests exact metadata; reject a different map.
			$bad=$map; $bad['accounts'][0]['identity']=$other;
			yes(rejected(fn()=>$paths->Adopt($bad,true)));
			// This fixture has created a fresh child after publication, so the
			// original generation cannot be resumed or replaced.
			yes(rejected(fn()=>$paths->Adopt($map,true)));
			yes(file_get_contents($legacy.'/settings') === 'owner-data');
		} elseif ('replacement' === $mode) {
			rename($legacy,$legacy.'-preserved'); mkdir($legacy,0700);
			yes(rejected(fn()=>$paths->Resolve($main)));
			yes(file_get_contents($legacy.'-preserved/settings') === 'owner-data');
		}
	}
} elseif ('nofsync-delete' === $mode) {
	$storage->Put($main,S::CONFIG,'two_factor','synthetic-enabled-factor');
	yes(rejected(fn()=>$storage->DeleteStorage($main)));
	yes($storage->Get($main,S::CONFIG,'two_factor') === 'synthetic-enabled-factor');
} elseif ('reattest-v2' === $mode) {
	$path=rtrim($paths->Resolve($main),'/');
	$child='child@example.test'; $childPath=rtrim($paths->Resolve($main,$child),'/');
	put($path.'/settings','owned-settings'); put($childPath.'/settings','owned-child');
	$id=AccountPath::Identity($main); $childId=AccountPath::Identity($main,$child);
	$v2map=['authoritative_ownership'=>true,'accounts'=>[['identity'=>$main,'layout'=>'v2','source'=>$id,
		'children'=>[['identity'=>$child,'layout'=>'v2','source'=>$childId]]]]];
	$restore=$temporary.'/restored'; rename($path,$restore); mkdir($path,0700);
	foreach (new DirectoryIterator($restore) as $item) {
		if (!$item->isDot()) { rename($item->getPathname(),$path.'/'.$item->getFilename()); }
	}
	rmdir($restore); yes(rejected(fn()=>$paths->Resolve($main)));
	$paths->Reattest($v2map); yes(file_get_contents($paths->Resolve($main).'settings') === 'owned-settings');
	yes(file_get_contents($paths->Resolve($main,$child).'settings') === 'owned-child');
	put($base.'-v2/.pending',''); put($base.'-v2/.identity-'.str_repeat('b',24),'interrupted-private-metadata');
	yes(rejected(fn()=>$paths->Resolve($main)));
	$paths->Reattest($v2map,true); yes(!file_exists($base.'-v2/.identity-'.str_repeat('b',24))); yes(file_get_contents($paths->Resolve($main).'settings') === 'owned-settings');
} elseif ('gc' === $mode) {
	$a=new FixtureMain($main); $child=new FixtureChild($main,'child@example.test');
	foreach ([S::SIGN_ME,S::SESSION] as $type) {
		$storage->Put($a,$type,'old','old'); $storage->Put($a,$type,'new','new');
		$directory=$storage->GenerateFilePath($a,$type);
		touch($directory.'old',time()-3600*24*40);
	}
	foreach ([$a,$child] as $account) {
		$old=$files->GenerateLocalFullFileName($account,'old');
		$new=$files->GenerateLocalFullFileName($account,'new');
		put($old); put($new); touch($old,time()-3600*48);
	}
	$storage->GC(); $files->GC(24);
	foreach ([S::SIGN_ME,S::SESSION] as $type) {
		yes($storage->Get($a,$type,'old','missing') === 'missing');
		yes($storage->Get($a,$type,'new') === 'new');
	}
	foreach ([$a,$child] as $account) { yes(!$files->FileExists($account,'old')); yes($files->FileExists($account,'new')); }
} elseif ('cache' === $mode) {
	$cache=new \MailSo\Cache\Drivers\File($temporary.'/cache');
	$cache->setPrefix($main); yes($cache->Set('fixture','one'));
	$cache->setPrefix($other); yes($cache->Get('fixture') === null);
	$cache->setPrefix($main); yes($cache->Get('fixture') === 'one');
} elseif ('orphan' === $mode) {
	$paths->Resolve($main);
	mkdir($base.'-v2/'.AccountPath::Identity($other),0700);
	yes(rejected(fn()=>$paths->Resolve($other)));
	yes(rejected(fn()=>$paths->Resolve($main)));
} else { throw new RuntimeException('Unknown fixture mode'); }
echo json_encode(['passed'=>true,'mode'=>$mode],JSON_THROW_ON_ERROR);

}
