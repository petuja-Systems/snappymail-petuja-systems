<?php
// Real dispatcher and CSRF checks; action methods only count inert fixture calls.
if ('cli' !== PHP_SAPI || 2 !== count($argv)) {
    http_response_code(404);
    exit(1);
}
define('APP_INDEX_ROOT_PATH', $argv[1] . '/');
define('APP_DATA_FOLDER_PATH', $argv[1] . '/data/');
$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';
$_SERVER['SERVER_NAME'] = $_SERVER['HTTP_HOST'] = '127.0.0.1';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['REQUEST_METHOD'] = 'POST';
$_SERVER['CONTENT_TYPE'] = 'application/x-www-form-urlencoded';
require dirname(__DIR__, 2) . '/snappymail/v/0.0.0/include.php';

class JsonMethodFixture extends \RainLoop\ActionsAdmin
{
    public int $mutations = 0;
    public int $reads = 0;
    public int $adminChecks = 0;
    public bool $allowAdmin = true;
    public bool $allowTwoFactor = true;
    public function isTwoFactorJsonActionAllowed($action, bool $admin): bool { return $this->allowTwoFactor; }
    public function IsAdminLoggined(bool $throw = true): bool
    {
        ++$this->adminChecks;
        if (!$this->allowAdmin) { throw new \RainLoop\Exceptions\ClientException(\RainLoop\Notifications::AuthError); }
        return true;
    }
    public function DoAdminUpgradeCore(): array { return $this->DoFixtureChange(); }
    public function DoContactsSync(): array { return $this->DoFixtureChange(); }
    public function DoLogout(): array { return $this->DoFixtureChange(); }
    public function DoFixtureChange(): array { ++$this->mutations; return $this->DefaultResponse(true); }
    public function DoMessage(): array { ++$this->reads; return $this->DefaultResponse(true); }
    public function DoMessageList(): array { return $this->DoMessage(); }
}

$token = \RainLoop\Utils::GetCsrfToken();
$run = function ($method, $action, array $options = []) use ($token): array {
    unset($_SERVER['REQUEST_METHOD'], $_SERVER['HTTP_X_SM_TOKEN'], $_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE']);
    if (null !== $method) { $_SERVER['REQUEST_METHOD'] = $method; }
    $_POST = empty($options['path']) ? ['Action' => $action] : [];
    if (isset($options['header'])) { $_SERVER['HTTP_X_SM_TOKEN'] = $options['header'] ? $token : 'invalid-fixture-token'; }
    if (isset($options['form'])) { $_POST['XToken'] = $options['form'] ? $token : 'invalid-fixture-token'; }
    if (!empty($options['override'])) {
        $_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE'] = 'POST';
        $_POST['_method'] = 'POST';
    }
    $actions = new JsonMethodFixture();
    $actions->allowAdmin = empty($options['denyAdmin']);
    $actions->allowTwoFactor = empty($options['denyTwoFactor']);
    $service = (new \RainLoop\ServiceActions(\MailSo\Base\Http::SingletonInstance(), $actions))
        ->SetPaths(['Json', '0', $action, 'synthetic-cache-key']);
    $response = json_decode($service->ServiceJson(), true, 512, JSON_THROW_ON_ERROR);
    return [
        'code' => $response['code'] ?? 0,
        'success' => true === ($response['Result'] ?? null),
        'mutations' => $actions->mutations, 'reads' => $actions->reads,
        'adminChecks' => $actions->adminChecks, 'rawKey' => $actions->GetActionParam('RawKey', '')
    ];
};
$cases = [
    'get_path' => $run('GET', 'AdminUpgradeCore', ['path' => true]),
    'get_valid_token' => $run('GET', 'AdminUpgradeCore', ['path' => true, 'header' => true]),
    'get_decoded_action' => $run('GET', 'AdminUpgradeCore', ['header' => true]),
    'get_lower_mutation' => $run('GET', 'contactsSync', ['path' => true]),
    'get_mixed_mutation' => $run('GET', 'aDmInUpGrAdEcOrE', ['path' => true]),
    'get_other_action' => $run('GET', 'FixtureChange', ['path' => true]),
    'get_logout' => $run('GET', 'Logout', ['path' => true]),
    'get_override' => $run('GET', 'AdminUpgradeCore', ['override' => true]),
    'get_array_action' => $run('GET', ['Message']),
    'head' => $run('HEAD', 'AdminUpgradeCore'),
    'put' => $run('PUT', 'AdminUpgradeCore'),
    'patch' => $run('PATCH', 'AdminUpgradeCore'),
    'delete' => $run('DELETE', 'AdminUpgradeCore'),
    'options' => $run('OPTIONS', 'Message'),
    'lower_post' => $run('post', 'AdminUpgradeCore'),
    'padded_post' => $run(' POST ', 'AdminUpgradeCore'),
    'missing_method' => $run(null, 'AdminUpgradeCore'),
    'post_header' => $run('POST', 'AdminUpgradeCore', ['header' => true]),
    'post_form' => $run('POST', 'AdminUpgradeCore', ['form' => true]),
    'post_future_action' => $run('POST', 'FixtureChange', ['header' => true]),
    'post_missing_token' => $run('POST', 'AdminUpgradeCore'),
    'post_bad_header' => $run('POST', 'AdminUpgradeCore', ['header' => false, 'form' => true]),
    'post_bad_form' => $run('POST', 'AdminUpgradeCore', ['form' => false]),
    'post_admin_denied' => $run('POST', 'AdminUpgradeCore', ['header' => true, 'denyAdmin' => true]),
    'post_two_factor_denied' => $run('POST', 'AdminUpgradeCore', ['header' => true, 'denyTwoFactor' => true]),
    'post_logout' => $run('POST', 'Logout'),
    'read_message' => $run('GET', 'Message', ['path' => true]),
    'read_list' => $run('GET', 'MessageList', ['path' => true, 'header' => true]),
    'read_lower' => $run('GET', 'message', ['path' => true]),
    'read_mixed' => $run('GET', 'mEsSaGeLiSt', ['path' => true]),
    'read_bad_token' => $run('GET', 'Message', ['path' => true, 'header' => false]),
    'read_two_factor_denied' => $run('GET', 'Message', ['path' => true, 'denyTwoFactor' => true])
];
echo json_encode($cases, JSON_THROW_ON_ERROR);
