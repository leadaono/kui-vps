"""Test public leaf certificate reporting without loading agent startup code."""
import ast
import hashlib
import os
import re
import ssl
import subprocess
import tempfile
import unittest
from pathlib import Path

source = Path(__file__).resolve().parents[1] / 'vendor/K-UI/vps/agent.py'
tree = ast.parse(source.read_text())
fn = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'hysteria2_certificate_hashes')
scope = {'os': os, 're': re}
exec(compile(ast.Module(body=[fn], type_ignores=[]), str(source), 'exec'), scope)
certificate_hashes = scope['hysteria2_certificate_hashes']

class CertificateHashes(unittest.TestCase):
    def test_only_matching_public_certificate(self):
        with tempfile.TemporaryDirectory() as tmp:
            cert = Path(tmp) / 'cert_hy2_1.pem'
            key = Path(tmp) / 'key_hy2_1.pem'
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=test.example', '-keyout', str(key), '-out', str(cert)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            expected = hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert.read_text())).hexdigest()
            nodes = [{'id': 'hy2_1', 'protocol': 'Hysteria2'}, {'id': '../bad', 'protocol': 'Hysteria2'}, {'id': 'hy2_1', 'protocol': 'TUIC'}]
            self.assertEqual(certificate_hashes(nodes, tmp), [{'id': 'hy2_1', 'sha256': expected}])
            cert.write_text(key.read_text())
            self.assertEqual(certificate_hashes(nodes, tmp), [])
            cert.unlink()
            self.assertEqual(certificate_hashes(nodes, tmp), [])

if __name__ == '__main__':
    unittest.main()
