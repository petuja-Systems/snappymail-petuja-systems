<?php

namespace RainLoop\Actions;

trait Raw
{
	/**
	 * @throws \MailSo\RuntimeException
	 */
	public function RawViewAsPlain() : bool
	{
		$oAccount = $this->getAccountFromToken();
		$sRawKey = $this->GetActionParam('RawKey', '');
		$aValues = $this->decodeRawKey($sRawKey);
		if (!empty($aValues['folder']) && !empty($aValues['uid'])
		 && !empty($aValues['accountHash']) && $aValues['accountHash'] === $oAccount->Hash()
		) {
			$this->verifyCacheByKey($sRawKey);
			$this->initMailClientConnection();
			\header('Content-Type: text/plain');
			return $this->MailClient()->MessageMimeStream(
				function ($rResource) use ($sRawKey) {
					if (\is_resource($rResource)) {
						$this->cacheByKey($sRawKey);
						\MailSo\Base\Utils::FpassthruWithTimeLimitReset($rResource);
					}
				},
				(string) $aValues['folder'],
				(int) $aValues['uid'],
				isset($aValues['mimeIndex']) ? (string) $aValues['mimeIndex'] : ''
			);
		}
		return false;
	}

	public function RawDownload() : bool
	{
		return $this->rawSmart(true);
	}

	public function RawView() : bool
	{
		return $this->rawSmart(false);
	}

	public function RawViewThumbnail() : bool
	{
		return $this->rawSmart(false, true);
	}

	private function clearFileName(string $sFileName, string $sContentType, string $sMimeIndex, int $iMaxLength = 250): string
	{
		$sFileName = !\strlen($sFileName) ? \preg_replace('/[^a-zA-Z0-9]/', '.', (empty($sMimeIndex) ? '' : $sMimeIndex . '.') . $sContentType) : $sFileName;
		$sClearedFileName = \MailSo\Base\Utils::StripSpaces(\preg_replace('/[\.]+/', '.', $sFileName));
		$sExt = \MailSo\Base\Utils::GetFileExtension($sClearedFileName);

		if (10 < $iMaxLength && $iMaxLength < \strlen($sClearedFileName) - \strlen($sExt)) {
			$sClearedFileName = \substr($sClearedFileName, 0, $iMaxLength) . (empty($sExt) ? '' : '.' . $sExt);
		}

		return \MailSo\Base\Utils::SecureFileName(\MailSo\Base\Utils::Utf8Clear($sClearedFileName));
	}

	/**
	 * Message, Message Attachment or Zip
	 */
	private function rawSmart(bool $bDownload, bool $bThumbnail = false) : bool
	{
		$sRawKey = (string) $this->GetActionParam('RawKey', '');

		$oAccount = $this->getAccountFromToken();
		$aValues = $this->decodeRawKey($sRawKey);
		if (empty($aValues['accountHash']) || $aValues['accountHash'] !== $oAccount->Hash()) {
			return false;
		}

		$this->verifyCacheByKey($sRawKey);
		$sRange = 'GET' === ($_SERVER['REQUEST_METHOD'] ?? 'GET') ? \MailSo\Base\Http::GetHeader('Range') : '';
		$sIfRange = \MailSo\Base\Http::GetHeader('If-Range');
		if ('' !== $sIfRange && $sIfRange !== '"'.$this->etag($sRawKey).'"') {
			$sRange = '';
		}

		$sMimeIndex = isset($aValues['mimeIndex']) ? (string) $aValues['mimeIndex'] : '';
		$sContentTypeIn = isset($aValues['mimeType']) ? (string) $aValues['mimeType'] : '';
		$sFileNameIn = isset($aValues['fileName']) ? (string) $aValues['fileName'] : '';

		if (!empty($aValues['fileHash'])) {
			$rResource = $this->FilesProvider()->GetFile($oAccount, (string) $aValues['fileHash']);
			if (!\is_resource($rResource)) {
				return false;
			}
			// https://github.com/the-djmaze/snappymail/issues/144
			if ('.pdf' === \substr($sFileNameIn,-4)) {
				$sContentTypeOut = 'application/pdf'; // application/octet-stream
			} else {
				$sContentTypeOut = $sContentTypeIn
					?: \SnappyMail\File\MimeType::fromFilename($sFileNameIn)
					?: 'application/octet-stream';
			}
			$sFileNameOut = $this->clearFileName($sFileNameIn, $sContentTypeIn, $sMimeIndex);
			\header('Content-Type: '.$sContentTypeOut);
			\MailSo\Base\Http::setContentDisposition('attachment', ['filename' => $sFileNameOut]);
			\header('Accept-Ranges: none');
			\header('Content-Transfer-Encoding: binary');
			\MailSo\Base\Utils::FpassthruWithTimeLimitReset($rResource);
			return true;
		}

		$sFolder = isset($aValues['folder']) ? (string) $aValues['folder'] : '';
		$iUid = isset($aValues['uid']) ? (int) $aValues['uid'] : 0;
		if (empty($sFolder) || 1 > $iUid) {
			return false;
		}

		$this->initMailClientConnection();

		$self = $this;
		return $this->MailClient()->MessageMimeStream(
			function($rResource, $sContentType, $sFileName, $sMimeIndex = '') use (
				$self, $sRawKey, $sContentTypeIn, $sFileNameIn, $bDownload, $bThumbnail,
				$sRange
			) {
				if (\is_resource($rResource)) {
					\MailSo\Base\Utils::ResetTimeLimit();

					$self->cacheByKey($sRawKey);

					$self->logWrite(\print_r([
						$sFileName,
						$sContentType,
						$sFileNameIn,
						$sContentTypeIn
					],true), \LOG_DEBUG, 'RAW');

					if ($sFileNameIn) {
						$sFileName = $sFileNameIn;
					}
					$sFileName = $self->clearFileName($sFileName, $sContentType, $sMimeIndex);

					if ('.pdf' === \substr($sFileName, -4)) {
						// https://github.com/the-djmaze/snappymail/issues/144
						$sContentType = 'application/pdf';
					} else {
						$sContentType = $sContentTypeIn
							?: $sContentType
//							?: \SnappyMail\File\MimeType::fromStream($rResource, $sFileName)
							?: \SnappyMail\File\MimeType::fromFilename($sFileName)
							?: 'application/octet-stream';
					}

					if (!$bDownload) {
						$bDetectImageOrientation = $self->Config()->Get('labs', 'image_exif_auto_rotate', false)
							// Mostly only JPEG has EXIF metadata
							&& 'image/jpeg' == $sContentType;
						try
						{
							if ($bThumbnail) {
								$oImage = static::loadImage($rResource, $bDetectImageOrientation, 48);
								\MailSo\Base\Http::setContentDisposition('inline', ['filename' => $sFileName.'_thumb60x60.png']);
								$oImage->show('png');
//								$oImage->show('webp'); // Little Britain: "Safari says NO"
								exit;
							} else if ($bDetectImageOrientation) {
								$oImage = static::loadImage($rResource, $bDetectImageOrientation);
								\MailSo\Base\Http::setContentDisposition('inline', ['filename' => $sFileName]);
								$oImage->show();
//								$oImage->show('webp'); // Little Britain: "Safari says NO"
								exit;
							}
						}
						catch (\Throwable $oException)
						{
							$self->Logger()->WriteExceptionShort($oException);
							\MailSo\Base\Http::StatusHeader(500);
							exit;
						}
					}

					// Only explicitly supported preview formats may be inline.
					// Transformed images above are bounded raster output; never download
					// the original document as a fallback for a failed thumbnail.
					$bInline = \in_array(\strtolower(\trim(\explode(';', $sContentType, 2)[0])), [
						'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
						'image/bmp', 'image/tiff', 'image/x-icon', 'image/vnd.microsoft.icon',
						'application/pdf', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/webm',
						'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/x-flac', 'audio/aac',
						'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'
					], true);

					if (!\headers_sent()) {
						\header('Content-Type: '.$sContentType);
						\MailSo\Base\Http::setContentDisposition($bDownload || !$bInline ? 'attachment' : 'inline', ['filename' => $sFileName]);
						\header('Accept-Ranges: bytes');
						\header('Content-Transfer-Encoding: binary');
					}

					$self->streamRaw($rResource, $sRange);
				}
			}, $sFolder, $iUid, $sMimeIndex
		);
	}

	private function streamRaw($rResource, string $sRange) : void
	{
		$aRange = [];
		if (!\preg_match('/\Abytes=([0-9]*)-([0-9]*)\z/i', \trim($sRange), $aRange)
			|| ('' === $aRange[1] && '' === $aRange[2])) {
			\MailSo\Base\Utils::FpassthruWithTimeLimitReset($rResource);
			return;
		}
		// Ignore unsupported huge numerals rather than risking integer overflow.
		foreach ([1, 2] as $i) {
			$sNumber = \ltrim($aRange[$i], '0') ?: '0';
			$sMax = (string) PHP_INT_MAX;
			if (\strlen($sNumber) > \strlen($sMax)
				|| (\strlen($sNumber) === \strlen($sMax) && \strcmp($sNumber, $sMax) > 0)) {
				\MailSo\Base\Utils::FpassthruWithTimeLimitReset($rResource);
				return;
			}
		}
		if ('' !== $aRange[1] && '' !== $aRange[2] && (int) $aRange[1] > (int) $aRange[2]) {
			\MailSo\Base\Utils::FpassthruWithTimeLimitReset($rResource);
			return;
		}

		// Decoded IMAP streams are forward-only; their stat size may be encoded.
		// Bound both RAM and temporary disk, then ignore Range for larger bodies.
		$iStageLimit = 8 * 1024 * 1024;
		$rStage = \MailSo\Base\ResourceRegistry::CreateMemoryResource(1);
		if (!\is_resource($rStage)) {
			\header('Accept-Ranges: none');
			\MailSo\Base\Utils::FpassthruWithTimeLimitReset($rResource);
			return;
		}
		try {
			$iTotal = 0;
			while (!\feof($rResource) && $iTotal <= $iStageLimit) {
				$sChunk = \fread($rResource, \min(8192, $iStageLimit + 1 - $iTotal));
				if (false === $sChunk || ('' === $sChunk && !\feof($rResource))) {
					throw new \RuntimeException('Raw stream read failed');
				}
				if (\fwrite($rStage, $sChunk) !== \strlen($sChunk)) {
					throw new \RuntimeException('Raw stream staging failed');
				}
				$iTotal += \strlen($sChunk);
				\MailSo\Base\Utils::ResetTimeLimit();
			}
			\rewind($rStage);
			if ($iTotal > $iStageLimit) {
				\header('Accept-Ranges: none');
				\MailSo\Base\Utils::FpassthruWithTimeLimitReset($rStage);
				\MailSo\Base\Utils::FpassthruWithTimeLimitReset($rResource);
				return;
			}
			$iStart = '' === $aRange[1] ? \max(0, $iTotal - (int) $aRange[2]) : (int) $aRange[1];
			$iEnd = '' === $aRange[1] || '' === $aRange[2] ? $iTotal - 1 : \min($iTotal - 1, (int) $aRange[2]);
			if (!$iTotal || $iStart >= $iTotal || ('' === $aRange[1] && 0 === (int) $aRange[2])) {
				\http_response_code(416);
				\header('Content-Range: bytes */'.$iTotal);
				\header('Content-Length: 0');
				return;
			}
			if (0 !== \fseek($rStage, $iStart)) {
				throw new \RuntimeException('Raw stream seek failed');
			}
			\MailSo\Base\Http::StatusHeader(206);
			\header('Content-Range: bytes '.$iStart.'-'.$iEnd.'/'.$iTotal);
			$iRemaining = $iEnd - $iStart + 1;
			\header('Content-Length: '.$iRemaining);
			while ($iRemaining > 0) {
				$sChunk = \fread($rStage, \min(8192, $iRemaining));
				if (false === $sChunk || '' === $sChunk) {
					throw new \RuntimeException('Raw staged stream read failed');
				}
				$iRemaining -= \strlen($sChunk);
				echo $sChunk;
				\MailSo\Base\Utils::ResetTimeLimit();
			}
		} catch (\Throwable $e) {
			if (!\headers_sent()) {
				\MailSo\Base\Http::StatusHeader(500);
				\header_remove('Content-Range');
				\header('Content-Length: 0');
			}
		} finally {
			\MailSo\Base\ResourceRegistry::CloseMemoryResource($rStage);
		}
	}

	private static function loadImage($resource, bool $bDetectImageOrientation = false, int $iThumbnailBoxSize = 0) : \SnappyMail\Image
	{
		// GD produces one raster; optional Magick decoders can load whole sequences/delegates.
		if (!\extension_loaded('gd')) {
			throw new \RuntimeException('GD is required for image transformation');
		}
		$data = \SnappyMail\Image\Limits::read($resource);
		\SnappyMail\Image\Limits::inspect($data);
		$oImage = \SnappyMail\Image\GD2::createFromString($data);

		if (!$oImage->valid()) {
			throw new \Exception('Loading image failed');
		}

		// rotateImageByOrientation
		if ($bDetectImageOrientation) {
			switch ($oImage->getOrientation())
			{
				case 2: // flip horizontal
					$oImage->flopImage();
					break;

				case 3: // rotate 180
					$oImage->rotate(180);
					break;

				case 4: // flip vertical
					$oImage->flipImage();
					break;

				case 5: // vertical flip + 90 rotate
					$oImage->flipImage();
					$oImage->rotate(90);
					break;

				case 6: // rotate 90
					$oImage->rotate(90);
					break;

				case 7: // horizontal flip + 90 rotate
					$oImage->flopImage();
					$oImage->rotate(90);
					break;

				case 8: // rotate 270
					$oImage->rotate(270);
					break;
			}
		}

		if (0 < $iThumbnailBoxSize) {
			$oImage->cropThumbnailImage($iThumbnailBoxSize, $iThumbnailBoxSize);
		}

		$oImage->stripImage();

		return $oImage;
	}

}
