#!/usr/bin/env python3
"""Ephemeral loopback-only IMAP/SMTP/Sieve TLS trust probe."""
import asyncio
import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile

REPO = Path(__file__).resolve().parents[2]
PHP_RUNNER = Path(__file__).with_name("mail-tls-trust.php")
HOST = "127.0.0.1"
PROTOCOLS = ("imap", "smtp", "sieve")
TRANSPORTS = ("implicit", "starttls")

def run(command, cwd):
    result = subprocess.run(command, cwd=cwd, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"fixture generation failed: {Path(command[0]).name} exit {result.returncode}")
    return result

def make_ca(root, name):
    key = root / f"{name}-ca.key"
    cert = root / f"{name}-ca.pem"
    run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", str(key), "-out", str(cert), "-subj", f"/CN={name} synthetic test CA",
        "-days", "2", "-sha256",
        "-addext", "basicConstraints=critical,CA:TRUE",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign"
    ], root)
    key.chmod(0o600)
    return cert, key

def make_leaf(root, name, ca_cert, ca_key, san):
    key = root / f"{name}.key"
    csr = root / f"{name}.csr"
    cert = root / f"{name}.pem"
    ext = root / f"{name}.ext"
    run([
        "openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes",
        "-keyout", str(key), "-out", str(csr), "-subj", "/CN=mail TLS fixture"
    ], root)
    ext.write_text(
        "[server_cert]\n"
        "basicConstraints=critical,CA:FALSE\n"
        "keyUsage=critical,digitalSignature,keyEncipherment\n"
        "extendedKeyUsage=serverAuth\n"
        f"subjectAltName={san}\n",
        encoding="ascii"
    )
    run([
        "openssl", "x509", "-req", "-in", str(csr),
        "-CA", str(ca_cert), "-CAkey", str(ca_key), "-CAcreateserial",
        "-out", str(cert), "-days", "2", "-sha256",
        "-extfile", str(ext), "-extensions", "server_cert"
    ], root)
    key.chmod(0o600)
    return cert, key

def server_context(cert, key):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(cert), str(key))
    return context

async def write_line(writer, value):
    writer.write((value + "\r\n").encode("ascii"))
    await writer.drain()

async def read_line(reader):
    raw = await asyncio.wait_for(reader.readline(), 6)
    return raw.decode("ascii", errors="replace").strip()

async def smtp_caps(writer):
    writer.write(b"250-loopback fixture\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n")
    await writer.drain()

async def imap_caps(writer):
    writer.write(b"* CAPABILITY IMAP4rev1 STARTTLS\r\n")
    await writer.drain()

async def sieve_greeting(writer):
    writer.write(
        b'"IMPLEMENTATION" "loopback fixture"\r\n'
        b'"STARTTLS" ""\r\n'
        b'"SASL" "PLAIN"\r\n'
        b'"SIEVE" "fileinto"\r\n'
        b'OK "ready"\r\n'
    )
    await writer.drain()

async def session(reader, writer, protocol, transport, context):
    try:
        if protocol == "imap":
            writer.write(b"* OK [CAPABILITY IMAP4rev1 STARTTLS] loopback fixture\r\n")
            await writer.drain()
        elif protocol == "smtp":
            await write_line(writer, "220 loopback fixture ESMTP")
        else:
            await sieve_greeting(writer)

        if transport in ("starttls", "auto"):
            while True:
                line = await read_line(reader)
                if not line:
                    return
                upper = line.upper()
                if protocol == "imap":
                    parts = line.split()
                    tag = parts[0] if parts else "A0001"
                    command = parts[1].upper() if len(parts) > 1 else ""
                    if command == "CAPABILITY":
                        await imap_caps(writer)
                        await write_line(writer, f"{tag} OK capability")
                    elif command == "STARTTLS":
                        await write_line(writer, f"{tag} OK begin TLS")
                        break
                    elif command == "LOGOUT":
                        writer.write(b"* BYE logout\r\n")
                        await write_line(writer, f"{tag} OK logout")
                        return
                    else:
                        await write_line(writer, f"{tag} OK fixture")
                elif protocol == "smtp":
                    if upper.startswith(("EHLO ", "HELO ")):
                        await smtp_caps(writer)
                    elif upper == "STARTTLS":
                        await write_line(writer, "220 begin TLS")
                        break
                    elif upper == "QUIT":
                        await write_line(writer, "221 bye")
                        return
                    else:
                        await write_line(writer, "250 fixture")
                else:
                    if upper == "STARTTLS":
                        await write_line(writer, 'OK "begin TLS"')
                        break
                    elif upper == "LOGOUT":
                        await write_line(writer, 'OK "bye"')
                        return
                    elif upper == "CAPABILITY":
                        await sieve_greeting(writer)
                    else:
                        await write_line(writer, 'OK "fixture"')

            loop = asyncio.get_running_loop()
            upgraded = await loop.start_tls(
                writer.transport, writer._protocol, context,
                server_side=True, ssl_handshake_timeout=6
            )
            writer._transport = upgraded
            if protocol == "sieve":
                await sieve_greeting(writer)
            elif protocol == "smtp":
                line = await read_line(reader)
                if line.upper().startswith(("EHLO ", "HELO ")):
                    await smtp_caps(writer)

        while True:
            line = await read_line(reader)
            if not line:
                return
            upper = line.upper()
            if protocol == "imap":
                parts = line.split()
                tag = parts[0] if parts else "A0001"
                command = parts[1].upper() if len(parts) > 1 else ""
                if command == "CAPABILITY":
                    await imap_caps(writer)
                    await write_line(writer, f"{tag} OK capability")
                elif command == "LOGOUT":
                    writer.write(b"* BYE logout\r\n")
                    await write_line(writer, f"{tag} OK logout")
                    return
                else:
                    await write_line(writer, f"{tag} OK fixture")
            elif protocol == "smtp":
                if upper.startswith(("EHLO ", "HELO ")):
                    await smtp_caps(writer)
                elif upper == "QUIT":
                    await write_line(writer, "221 bye")
                    return
                else:
                    await write_line(writer, "250 fixture")
            else:
                if upper == "LOGOUT":
                    await write_line(writer, 'OK "bye"')
                    return
                elif upper == "CAPABILITY":
                    await sieve_greeting(writer)
                else:
                    await write_line(writer, 'OK "fixture"')
    except (asyncio.IncompleteReadError, asyncio.TimeoutError, ssl.SSLError, ConnectionError, OSError):
        return
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except (ssl.SSLError, ConnectionError, OSError):
            pass

async def one_probe(protocol, transport, certificate, key, mode, ca_file, data_root, host_scheme=None, plaintext=False):
    context = server_context(certificate, key)
    tls_context = context if transport == "implicit" and not plaintext else None
    writers = set()
    tasks = set()
    connections = []
    async def handle_client(reader, writer):
        connections.append(True)
        task = asyncio.current_task()
        writers.add(writer)
        tasks.add(task)
        try:
            await session(reader, writer, protocol, transport, context)
        finally:
            writers.discard(writer)
            tasks.discard(task)
    server = await asyncio.start_server(
        handle_client, HOST, 0, ssl=tls_context,
        ssl_handshake_timeout=6 if tls_context else None
    )
    port = server.sockets[0].getsockname()[1]
    env = os.environ.copy()
    env["PETUJA_REPO_ROOT"] = str(REPO)
    env["PETUJA_TEST_DATA_PATH"] = str(data_root)
    env["PETUJA_MAIL_TLS_PROTOCOL"] = protocol
    env["PETUJA_MAIL_TLS_TRANSPORT"] = transport
    env["PETUJA_MAIL_TLS_MODE"] = mode
    env["PETUJA_MAIL_TLS_PORT"] = str(port)
    env["PETUJA_MAIL_TLS_CA"] = str(ca_file or "")
    env["PETUJA_MAIL_TLS_HOST"] = f"{host_scheme}://{HOST}" if host_scheme else HOST
    config = data_root / "_data_" / "_default_" / "configs"
    config.mkdir(parents=True, exist_ok=True)
    (config / "application.ini").write_text(
        '[ssl]\nverify_certificate = Off\nallow_self_signed = On\n'
        + ('cafile = "' + str(ca_file) + '"\n' if mode == "ini" else '')
        + '[security]\nrequire_two_factor_auth = Off\n'
        + '[version]\ntwo_factor_policy_migration = 1\n', encoding="utf8")
    if mode == "capath":
        run(["openssl", "rehash", str(ca_file.parent)], ca_file.parent)
    process = None
    try:
        process = await asyncio.create_subprocess_exec(
            os.environ.get("PHP_BINARY", "php"), "-d", f"openssl.cafile={ca_file if mode == 'system' else ''}", str(PHP_RUNNER), env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=12)
        stdout = stdout.decode("utf-8", errors="replace")
        stderr = stderr.decode("utf-8", errors="replace")
        lines = [line for line in stdout.splitlines() if line.startswith("{")]
        if process.returncode != 0 or not lines:
            raise RuntimeError(
                f"PHP probe failed for {protocol}/{transport}/{mode}: "
                f"exit={process.returncode}, stdout={stdout[-600:]!r}, stderr={stderr[-600:]!r}"
            )
        observation = json.loads(lines[-1])
        if (host_scheme in ("SSL", "tLs") and transport != "implicit") or (host_scheme and "://" in host_scheme):
            observation["target_connected"] = bool(connections)
    finally:
        if process and process.returncode is None:
            process.kill()
            await process.wait()
        server.close()
        await server.wait_closed()
        remaining_writers = tuple(writers)
        remaining_tasks = tuple(tasks)
        for writer in remaining_writers:
            writer.close()
        for task in remaining_tasks:
            task.cancel()
        if remaining_tasks:
            await asyncio.gather(*remaining_tasks, return_exceptions=True)
        await asyncio.sleep(0)
    return observation

async def main():
    with tempfile.TemporaryDirectory(prefix="petuja-mail-tls-") as work:
        root = Path(work)
        trusted_ca, trusted_ca_key = make_ca(root, "trusted")
        untrusted_ca, untrusted_ca_key = make_ca(root, "untrusted")
        trusted_leaf = make_leaf(root, "trusted-leaf", trusted_ca, trusted_ca_key, "IP:127.0.0.1,DNS:localhost")
        untrusted_leaf = make_leaf(root, "untrusted-leaf", untrusted_ca, untrusted_ca_key, "IP:127.0.0.1,DNS:localhost")
        wrong_host_leaf = make_leaf(root, "wrong-host-leaf", trusted_ca, trusted_ca_key, "IP:127.0.0.2,DNS:wrong.example.invalid")
        data_root = root / "data"
        data_root.mkdir()
        observations = {}
        for protocol in PROTOCOLS:
            observations[protocol] = {}
            for transport in TRANSPORTS:
                cases = [
                    ("legacy_untrusted", "saved", untrusted_leaf, None),
                    ("legacy_self_signed", "saved", (trusted_ca, trusted_ca_key), None),
                    ("wrong_host", "saved", wrong_host_leaf, trusted_ca),
                    ("trusted_CA", "saved", trusted_leaf, trusted_ca),
                    ("alias", "alias", trusted_leaf, trusted_ca),
                    ("wildcard", "wildcard", trusted_leaf, trusted_ca),
                    ("legacy_INI", "ini", trusted_leaf, trusted_ca),
                    ("system_trust", "system", trusted_leaf, trusted_ca),
                    ("CA_directory", "capath", trusted_leaf, trusted_ca),
                    ("direct_flags_untrusted", "direct", untrusted_leaf, trusted_ca),
                    ("direct_flags_wrong_host", "direct", wrong_host_leaf, trusted_ca),
                ]
                for name, mode, (cert, key), ca_file in cases:
                    observed = await one_probe(protocol, transport, cert, key, mode, ca_file, data_root)
                    observations[protocol][transport + "_" + name] = observed
            for scheme in ("tcp", "SSL", "tLs"):
                observations[protocol][scheme + "_implicit"] = await one_probe(
                    protocol, "implicit", *trusted_leaf, "saved", trusted_ca, data_root, host_scheme=scheme)
                for transport in ("starttls", "none", "auto"):
                    observations[protocol][scheme + "_" + transport] = await one_probe(
                        protocol, transport, *trusted_leaf, "saved", trusted_ca, data_root, host_scheme=scheme)
            for transport in ("implicit", "starttls", "none", "auto"):
                observations[protocol]["nested_" + transport] = await one_probe(
                    protocol, transport, *trusted_leaf, "saved", trusted_ca, data_root, host_scheme="tcp://SSL")
            observations[protocol]["explicit_plaintext"] = await one_probe(
                protocol, "none", *trusted_leaf, "saved", trusted_ca, data_root)
            observations[protocol]["auto_STARTTLS"] = await one_probe(
                protocol, "auto", *trusted_leaf, "saved", trusted_ca, data_root)
            observations[protocol]["plaintext_rejected"] = await one_probe(
                protocol, "implicit", *trusted_leaf, "saved", trusted_ca, data_root,
                host_scheme="tcp", plaintext=True)
        print(json.dumps(observations, sort_keys=True))

if __name__ == "__main__":
    asyncio.run(main())
