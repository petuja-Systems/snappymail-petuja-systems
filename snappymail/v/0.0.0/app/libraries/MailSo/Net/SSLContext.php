<?php

/*
 * This file is part of MailSo.
 *
 * (c) 2022 DJMaze
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 *
 * https://www.php.net/context.ssl
 */

namespace MailSo\Net;

/**
 * @category MailSo
 * @package Net
 */
class SSLContext implements \JsonSerializable
{
//	public string $peer_name = '';
//	public string $peer_fingerprint = '';
	public bool $verify_peer = true;
	public bool $verify_peer_name = true;
	public bool $allow_self_signed = false;
	public string $cafile = '';
	public string $capath = '';
//	public string $ciphers = 'HIGH:!SSLv2:!SSLv3';
	public bool $SNI_enabled = true;
	public bool $disable_compression = true;
	public int $security_level = 1;
	public string $local_cert = '';
//	public string $local_pk = '';
//	public string $passphrase = '';
//	public int $verify_depth = 0;
//	public bool $capture_peer_cert = false;
//	public bool $capture_peer_cert_chain = false;

	public function __construct()
	{
		$oConfig = \RainLoop\Api::Config();
		$this->cafile = \trim($oConfig->Get('ssl', 'cafile', ''));
		$this->capath = \trim($oConfig->Get('ssl', 'capath', ''));
		$this->disable_compression = !!$oConfig->Get('ssl', 'disable_compression', true);
		$this->security_level = (int) $oConfig->Get('ssl', 'security_level', 1);
		$this->local_cert = \trim($oConfig->Get('ssl', 'local_cert', ''));
	}

	public static function fromArray(array $settings) : self
	{
		$object = new static;
		foreach ($settings as $key => $value) {
			if (!\in_array($key, ['verify_peer', 'verify_peer_name', 'allow_self_signed', 'peer_name'], true)) {
				$object->$key = $value;
			}
		}
		return $object;
	}

	#[\ReturnTypeWillChange]
	public function jsonSerialize()
	{
		$aResult = \get_object_vars($this);
		// Enforce trust for old saved domains and direct API callers alike.
		$aResult['verify_peer'] = true;
		$aResult['verify_peer_name'] = true;
		$aResult['allow_self_signed'] = false;
		// The socket host, not saved context metadata, selects the peer identity.
		unset($aResult['peer_name']);
//		$aResult['@Object'] = 'Object/SSLContext';
		return \array_filter(
			$aResult,
			function($var){return !\is_string($var) || \strlen($var);}
		);
	}

}
