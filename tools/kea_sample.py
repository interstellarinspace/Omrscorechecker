"""Download one centre's OMR PDF from KEA for debugging the scanner, encrypted to a public key.

Run by .github/workflows/kea-sample.yml (manual). The PDF holds candidates' sheets, so it is
never stored in the repository: it is encrypted (RSA-OAEP + AES-GCM) to the public key given
as input and uploaded as a short-lived workflow artifact that only the key holder can open.
"""
import argparse
import base64
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kea_fetch as KF  # noqa: E402


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="https://kearesults.karnataka.gov.in/keaomrs/kries.aspx")
    p.add_argument("--exam", required=True)
    p.add_argument("--district", required=True)
    p.add_argument("--centre", required=True)
    p.add_argument("--subject", default="", help="part of the KEA subject name (default: first)")
    p.add_argument("--pubkey", required=True, help="base64 DER SubjectPublicKeyInfo")
    p.add_argument("--out", default="sample.bin")
    a = p.parse_args()
    site = KF.KeaSite(a.url, KF.Polite(delay=20))
    site.load()
    site.choose("ddlExam", {"ddlExam": a.exam})
    site.choose("ddlDistrict", {"ddlExam": a.exam, "ddlDistrict": a.district})
    subs = KF.options(site.page, "ddlSubject")
    sval = next((v for v, t in subs if a.subject.lower() in t.lower()), subs[0][0])
    f = {"ddlExam": a.exam, "ddlDistrict": a.district, "ddlSubject": sval}
    site.choose("ddlSubject", f)
    row = next(c for c in KF.centres(site.page) if c[0] == a.centre)
    link = site.pdf_url(f, row[2])
    tmp = os.path.join(os.environ.get("RUNNER_TEMP", "/tmp"), "c.pdf")
    site.download(link, tmp)
    with open(tmp, "rb") as fh:
        data = fh.read()
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    k = os.urandom(32)
    pub = serialization.load_der_public_key(base64.b64decode(a.pubkey))
    wrapped = pub.encrypt(k, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    with open(a.out, "wb") as fh:
        fh.write(len(wrapped).to_bytes(2, "big") + wrapped + KF.seal_bytes(k, data))
    os.remove(tmp)
    print("saved encrypted sample,", len(data), "bytes")


if __name__ == "__main__":
    main()
