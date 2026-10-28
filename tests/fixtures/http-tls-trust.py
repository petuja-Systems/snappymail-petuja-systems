"""Loopback-only TLS fixtures. All keys/certificates are ephemeral and removed."""

import http.server
import json
import os
import pathlib
import socketserver
import ssl
import subprocess
import sys
import tempfile
import threading


records = []
servers = []


def openssl(*args):
    subprocess.run(["openssl", *map(str, args)], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def leaf(work, name, san, self_signed=False):
    key, csr, cert, ext = [work / (name + suffix) for suffix in
                           (".key", ".csr", ".pem", ".ext")]
    openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
            "-subj", "/CN=isolated-fixture", "-out", csr)
    extensions = ("basicConstraints=critical,CA:FALSE\n"
                  "keyUsage=critical,digitalSignature,keyEncipherment\n"
                  "extendedKeyUsage=serverAuth\nsubjectAltName=" + san + "\n")
    ext.write_text(extensions)
    if self_signed:
        openssl("req", "-x509", "-new", "-key", key, "-days", "2", "-sha256",
                "-subj", "/CN=isolated-fixture", "-addext", "subjectAltName=" + san,
                "-out", cert)
    else:
        openssl("x509", "-req", "-in", csr, "-CA", work / "ca.pem",
                "-CAkey", work / "ca.key", "-CAcreateserial", "-days", "2",
                "-sha256", "-extfile", ext, "-out", cert)
    return cert, key


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        auth = self.headers.get("Authorization")
        records.append((self.server.server_port, self.path, bool(auth)))
        if self.path in ("/challenge", "/auth-redirect") and not auth:
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="isolated-fixture"')
        elif self.path in ("/redirect", "/auth-redirect", "/same-origin", "/same-origin-mixed"):
            self.send_response(302)
            location = self.server.target
            if self.path == "/same-origin":
                location = "/challenge"
            elif self.path == "/same-origin-mixed":
                location = "hTtPs://127.0.0.1:" + str(self.server.server_port) + "/challenge"
            elif self.path == "/auth-redirect":
                location = location.replace("/target", "/challenge")
            self.send_header("Location", location)
        else:
            self.send_response(200)
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()


def server(pair=None, target=""):
    result = Server(("127.0.0.1", 0), Handler)
    result.target = target
    if pair:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(*map(str, pair))
        result.socket = context.wrap_socket(result.socket, server_side=True)
    threading.Thread(target=result.serve_forever, daemon=True).start()
    servers.append(result)
    return result


def url(instance, path="/", scheme="https"):
    return scheme + "://127.0.0.1:" + str(instance.server_port) + path


def request(kind, case, target, ca, redirects=0, trust=False):
    command = [os.environ.get("PHP_BINARY", "php"), "-d", "display_errors=0",
               "-d", "log_errors=0", "-d", "error_reporting=0"]
    if trust:
        command += ["-d", "openssl.cafile=" + str(ca), "-d", "curl.cainfo=" + str(ca)]
    if kind == "carddav-socket":
        command += ["-d", "disable_functions=curl_init"]
    command += [str(pathlib.Path(__file__).with_suffix(".php")), kind, case,
                target, str(ca), str(redirects)]
    process = subprocess.run(command, capture_output=True, text=True, timeout=15)
    if process.returncode:
        raise RuntimeError("PHP fixture failed: " + process.stderr)
    return json.loads(process.stdout)


def exercise(work):
    ca = work / "ca.pem"
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout",
            work / "ca.key", "-days", "2", "-sha256", "-subj", "/CN=isolated CA",
            "-addext", "basicConstraints=critical,CA:TRUE",
            "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", ca)
    trusted_pair = leaf(work, "trusted", "IP:127.0.0.1,DNS:localhost")
    trusted = server(trusted_pair)
    untrusted = server(leaf(work, "untrusted", "IP:127.0.0.1", True))
    mismatch = server(leaf(work, "mismatch", "DNS:wrong.example.test"))
    self_signed_mismatch = server(leaf(work, "self-signed-mismatch", "DNS:wrong.example.test", True))
    if "--oauth" in sys.argv:
        result = {
            "self_signed": request("oauth", "default", url(untrusted), ca),
            "unknown_CA": request("oauth", "default", url(trusted), ca),
            "system_trust": request("oauth", "default", url(trusted), ca, trust=True),
            "custom_CA": request("oauth", "custom", url(trusted), ca),
            "wrong_host": request("oauth", "custom", url(mismatch), ca),
            "wrong_host_default": request("oauth", "default", url(mismatch), ca, trust=True)
        }
        result["untrusted_application_requests"] = sum(
            port in (untrusted.server_port, mismatch.server_port) for port, _, _ in records)
        return result
    plaintext = server()
    redirected = server(trusted_pair, url(trusted, "/target"))
    downgrade = server(trusted_pair, url(plaintext, scheme="http"))
    result = {}
    for kind in ("curl", "socket"):
        cases = {
            "self_signed": request(kind, "default", url(untrusted), ca),
            "explicit_self_signed": request(kind, "explicit-self-signed", url(untrusted), ca),
            "explicit_wrong_host": request(kind, "explicit-self-signed", url(self_signed_mismatch), ca),
            "unknown_CA": request(kind, "default", url(trusted), ca),
            "system_trust": request(kind, "default", url(trusted), ca, trust=True),
            "custom_CA": request(kind, "custom", url(trusted), ca),
            "wrong_host": request(kind, "custom", url(mismatch), ca),
            "plain_HTTP": request(kind, "default", url(plaintext, scheme="http"), ca),
            "same_origin_auth": request(kind, "auth", url(redirected, "/same-origin"), ca, 1),
            "mixed_scheme_direct": request(kind, "auth", url(trusted, "/challenge").replace("https:", "hTtPs:"), ca),
            "mixed_scheme_redirect": request(kind, "auth", url(redirected, "/same-origin-mixed"), ca, 1)
        }
        for label, case, instance, endpoint, hops in (
                ("cross_origin_header", "header", redirected, "/redirect", 1),
                ("cross_origin_auth", "auth", redirected, "/auth-redirect", 1),
                ("anonymous_redirect", "anonymous", redirected, "/redirect", 1),
                ("downgrade", "anonymous", downgrade, "/redirect", 1),
                ("no_follow", "no-follow", redirected, "/auth-redirect", 0)):
            before = len(records)
            cases[label] = request(kind, case, url(instance, endpoint), ca, hops)
            target_port = plaintext.server_port if label == "downgrade" else trusted.server_port
            cases[label + "_target_hit"] = any(port == target_port for port, _, _ in records[before:])
        before = len(records)
        cases["separate_client"] = request(kind, "cache", url(trusted, "/challenge"), ca)
        cases["cached_auth_leaked"] = any(endpoint == "/cache-probe" and auth
                                           for _, endpoint, auth in records[before:])
        result[kind] = cases
    for kind in ("carddav", "carddav-socket"):
        result[kind] = {
            "self_signed": request(kind, "default", url(untrusted), ca),
            "trusted": request(kind, "default", url(trusted), ca, trust=True),
            "wrong_host": request(kind, "default", url(mismatch), ca, trust=True),
            "mixed_scheme": request(kind, "default", url(trusted).replace("https:", "hTtPs:"), ca, trust=True)
        }
    return result


if __name__ == "__main__":
    try:
        with tempfile.TemporaryDirectory(prefix="petuja-http-tls-") as directory:
            print(json.dumps(exercise(pathlib.Path(directory))))
    finally:
        for instance in servers:
            instance.shutdown()
            instance.server_close()
