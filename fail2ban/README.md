# Fail2ban Instructions

This modified version of RainLoop logs to the system (when syslog works in PHP).

If you use other ports then http, https & 2096, modify them in /jail.d/*.conf

## Systemd journal PHP-FPM

Upload the following to /etc/fail2ban/*

- /filter.d/snappymail-fpm-journal.conf
- /jail.d/snappymail-fpm-journal.conf

Modify your /etc/fail2ban/jail.local with:

```
[snappymail-fpm-journal]
enabled = true
```

## Default log (not recommended)

Modify `/PATH-TO-RAINLOOP-DATA/_data_/_default_/configs/application.ini`

```
[logs]
auth_logging = On
auth_logging_filename = "fail2ban/auth-fail.log"
auth_logging_format = "[{date:Y-m-d H:i:s T}] Auth failed: ip={request:ip} user={imap:login} host={imap:host} port={imap:port}"
```

Modify the path in /jail.d/snappymail-log.conf

Upload the following to /etc/fail2ban/*

- /filter.d/snappymail-log.conf
- /jail.d/snappymail-log.conf

Modify your /etc/fail2ban/jail.local with:

```
[snappymail-log]
enabled = true
```

## Trustworthy source addresses

Core authentication logs use the web server's `REMOTE_ADDR`, never raw caller
forwarding headers. The legacy `labs.http_client_ip_check_proxy` option no
longer changes first-party logs. Configure any trusted reverse proxy through
an explicit web-server peer allowlist and overwritten client-address header;
see [Docker proxy guidance](../examples/docker/Docker.md#fpm-client-addresses-and-trusted-proxies).

With the default proxy configuration, the log records the immediate proxy.
Verify the logged address before enabling a jail, otherwise it can ban the
proxy and affect all its visitors. Do not enable a jail based on an arbitrary
X-Real-IP, Client-IP or X-Forwarded-For header. These examples do not configure
or activate bans automatically.
