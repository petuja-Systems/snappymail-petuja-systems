<?php

namespace RainLoop;

class KeyPathHelper
{
	static public function SsoCacherKey(string $sSsoHash) : string
	{
		return '/Sso/Data/'.$sSsoHash.'/Login/';
	}

	static public function ReadReceiptCache(string $sEmail, string $sFolderFullName, int $iUid) : string
	{
		return '/ReadReceipt/'.$sEmail.'/'.$sFolderFullName.'/'.$iUid;
	}

	static public function LangCache(string $sLanguage, bool $bAdmim) : string
	{
		return '/LangCache/'.$sLanguage.'/'.($bAdmim ? 'Admin' : 'App').'/'.APP_VERSION.'/';
	}

	static public function SessionAdminKey(string $sRand) : string
	{
		return '/Session/AdminKey/'.\md5($sRand).'/';
	}
}
