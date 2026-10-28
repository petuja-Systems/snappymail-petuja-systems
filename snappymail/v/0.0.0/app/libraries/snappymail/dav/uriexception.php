<?php

namespace SnappyMail\DAV;

/** A malformed or foreign DAV reference must abort discovery, never become an empty listing. */
class UriException extends \UnexpectedValueException
{
}
