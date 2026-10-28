# Examples

Here are some [`docker-compose`] examples.

## `docker-compose.simple.yml`

This runs `snappymail`, using [SQLite](https://www.sqlite.org/index.html) as the database.

Start the stack:

```sh
docker-compose -f docker-compose.simple.yml up
```

Get the Admin Panel password:

```sh
docker exec -it $( docker-compose -f docker-compose.simple.yml ps -q snappymail ) cat /var/lib/snappymail/_data_/_default_/admin_password.txt
```

Now, login to [http://localhost:8888/?admin](http://localhost:8888/?admin) with user `admin` and the admin password.

## `docker-compose.mysql.yml`

This runs `snappymail`, using [MariaDB](https://mariadb.org/) (a fork of [MYSQL](https://www.mysql.com/)) as the database.

Start `snappymail` and `mysql`:

```sh
docker-compose -f docker-compose.mysql.yml up
```

Get the Admin Panel password:

```sh
docker exec -it $( docker-compose -f docker-compose.mysql.yml ps -q snappymail ) cat /var/lib/snappymail/_data_/_default_/admin_password.txt
```

Now, login to [http://localhost:8888/?admin](http://localhost:8888/?admin) with user `admin` and the admin password.

To setup MySQL as the DB, in Admin Panel, click `Contacts`, check `Enable contacts` and , and under `Storage (PDO)` choose the following:

- Type: `MySQL`
- Data Source Name (DSN): `host=mysql;port=3306;dbname=snappymail`
- User `snappymail`
- Password `snappymail`

Click the `Test` button. If it turns green, MySQL is ready to be used for contacts.

To setup Redis for caching, in Admin Panel, click `Extensions`, update the following configuration options:

- `Cache Redis`: `install`
- `Cache Redis`: `enable`
- `Cache Redis > host`: `redis`
- `Cache Redis > port`: `6379`

Redis caching is now enabled.

## `docker-compose.postgres.yml`

This runs `snappymail`, using [PostgreSQL](https://hub.docker.com/_/postgres) as the database.

Start `snappymail` and `postgres`:

```sh
docker-compose -f docker-compose.postgres.yml up
```

Get the Admin Panel password:

```sh
docker exec -it $( docker-compose -f docker-compose.postgres.yml ps -q snappymail ) cat /var/lib/snappymail/_data_/_default_/admin_password.txt
```

Now, login to [http://localhost:8888/?admin](http://localhost:8888/?admin) with user `admin` and the admin password.

To use PostgreSQL as the DB, in Admin Panel, click `Contacts`, check `Enable contacts` and , and under `Storage (PDO)` choose the following:

- Type: `PostgresSQL`
- Data Source Name (DSN): `host=postgres;port=5432;dbname=snappymail`
- User `snappymail`
- Password `snappymail`

Click the `Test` button. If it turns green, PostgreSQL is ready to be used for contacts.

To setup Redis for caching, in Admin Panel, click `Extensions`, update the following configuration options:

- `Cache Redis`: `install`
- `Cache Redis`: `enable`
- `Cache Redis > host`: `redis`
- `Cache Redis > port`: `6379`

Redis caching is now enabled.

## `docker-compose.traefik.yml`

This runs `snappymail`, using [SQLite](https://www.sqlite.org/index.html) as the database, with `traefik` as the TLS reverse proxy and loadbalancer.

In this example, it is assumed the domain name is `snappymail.example.com`. It is assumed you have an [OVHcloud](https://www.ovh.com/auth/) account to obtain LetsEncrypt TLS certs via `ACME` using DNS challenge for the domain `snappymail.example.com`. If you are using another DNS provider, see [here](https://doc.traefik.io/traefik/https/acme/#providers).

To begin, edit the `OVH_*` environment variables in [`docker-compose.traefik.yml`](docker-compose.traefik.yml) accordingly:

```sh
nano docker-compose.traefik.yml
```

Start `snappymail` and `traefik`:

```sh
docker-compose -f docker-compose.traefik.yml up
```

`traefik` should now begin requesting a TLS cert for `snappymail.example.com`. The process may take a few minutes. If all goes well, https://snappymail.example.com should now be ready.

> You may still visit https://snappymail.example.com while waiting for `traefik` to be issued a TLS certificate. `traefik` simply serves a self-signed TLS cert.

Get the Admin Panel password:

```sh
docker exec -it $( docker-compose -f docker-compose.traefik.yml ps -q snappymail ) cat /var/lib/snappymail/_data_/_default_/admin_password.txt
```

Now, login to [https://snappymail.example.com/?admin](https://snappymail.example.com/?admin) with user `admin` and the admin password.

## FPM, client addresses and trusted proxies

The release image built from this checkout binds PHP-FPM only to
`127.0.0.1:9000`; Nginx and its readiness check use that same loopback endpoint.
Other containers must use Nginx on port 8888. Port 9000 metadata inherited from
the PHP base image does not open a network listener. Do not publish or widen
the FPM listener. Existing example image names refer to upstream images;
select your locally built image to test this checkout's configuration.

The optional network FPM exporter services have been removed from these
examples because they required exposing the complete FastCGI listener to peer
containers. Status remains available locally inside the application container;
this change does not add a replacement metrics service or grant a sidecar the
application's database/Redis network routes.

Core request and authentication logs always use `REMOTE_ADDR`. The old
`labs.http_client_ip_check_proxy` setting is ignored, including in saved
configuration. Raw Client-IP, X-Forwarded-For and X-Real-IP headers cannot
select the logged address. The public `GetClientIp(true)` library API is
unchanged for external code; first-party logging no longer uses that option.

By default, the bundled Nginx trusts its transport peer. Behind a reverse
proxy this is the proxy's address, so do not use a Fail2ban jail to ban visitor
addresses until the web server's trusted-proxy boundary is configured and
verified. To record visitors, mount an operator-managed Nginx configuration
with an explicit allowlist for the immediate proxy, for example within
`http { ... }` (replace these documentation-only addresses):

```nginx
set_real_ip_from 192.0.2.10/32;
set_real_ip_from 2001:db8::10/128;
real_ip_header X-Real-IP;
real_ip_recursive off;
```

Keep `fastcgi_param REMOTE_ADDR $remote_addr;`. The proxy must overwrite the
client-address header, and untrusted traffic must not be able to impersonate
that proxy or reach the backend through the same trusted source address.
Do not trust every container/private address or an entire forwarding chain.
Verify real-IP module availability and direct/forged-header/proxy behavior in
your deployment. Non-Docker web servers must establish the same trusted
`REMOTE_ADDR` boundary; the application does not infer proxy trust from a
request header.

## HTTPS metadata and application cookies

The application recognizes TLS only from server-generated CGI values:
`HTTPS=on` or `HTTPS=1`, or `REQUEST_SCHEME=https` (case-insensitive).
X-Forwarded-Proto, X-Forwarded-Ssl and other request headers, and a backend listener
on port 443, do not establish TLS. The retained `IsSecure(bool)` proxy argument
no longer enables request-header trust.

For direct Nginx TLS, pass its native transport value to PHP:

```nginx
fastcgi_param HTTPS $https if_not_empty;
```

For TLS termination at a reverse proxy, the operator must configure the final
web server to set the trusted CGI value only for requests known to have used
TLS at that edge. This requires an explicitly trusted immediate proxy,
overwritten scheme information, and a backend that untrusted clients cannot
reach through that trusted route. Do not copy an arbitrary request header into
the CGI value. Client-address rewriting alone does not establish scheme trust.

For an isolated backend route that receives exclusively HTTPS-terminated
requests, the operator can set `fastcgi_param HTTPS on;` in its PHP location.
That static declaration is unsuitable for a route that also receives public
HTTP requests. Enforce the HTTP-to-HTTPS redirect at the edge before forwarding.
Replace any existing HTTPS FastCGI declaration rather than relying on duplicate
parameter precedence. This checkout does not inspect or configure a live proxy.

The Traefik sample terminates TLS before the app's HTTP port 8888; its routing
labels alone do not configure this PHP-facing trust boundary. Supply an
operator-managed Nginx configuration for that topology. Without correct CGI
metadata, the app treats the backend request as HTTP, omits TLS-derived HSTS
and cookie Secure flags, and enabling `security.force_https` can cause a redirect
loop. The runtime-supplied `fastcgi_params` file is not verified by this source
example.

Native app cookies and the inline `smctoken` encryption-passphrase cookie share
their Secure policy: recognized transport, `security.cookie_samesite=None`, or
the explicit `labs.cookie_default_secure=On` override. The latter two are
cookie-only policies; they do not assert TLS, emit HSTS or suppress an HTTPS
redirect. `SECURE_COOKIES=true` in the image configures PHP's native session INI
only; it is not an application transport setting. Plain HTTP development remains
supported with the default app settings. The separate browser-storage fallback
cookie retains SameSite=Strict and adds Secure when the page URL is HTTPS;
it does not acquire the app's cookie-override configuration.
