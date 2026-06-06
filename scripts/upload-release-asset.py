#!/usr/bin/env python3
"""Upload local build artifact to existing GitHub Release"""
import json
import mimetypes
import os
import sys
import urllib.request
import urllib.error

REPO = "ymj8903668-droid/trading-review-wiki"
PAT_PATH = os.path.expanduser("~/.github_pat_trading_review_wiki")

def get_pat():
    with open(PAT_PATH, "r", encoding="utf-8") as f:
        return f.read().strip().lstrip("\ufeff")

def get_release(tag, pat):
    url = f"https://api.github.com/repos/{REPO}/releases/tags/{tag}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {pat}",
        "Accept": "application/vnd.github+json",
    })
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

def upload_asset(release, filepath, pat):
    upload_url = release["upload_url"].replace("{?name,label}", "")
    filename = os.path.basename(filepath)
    url = f"{upload_url}?name={urllib.parse.quote(filename)}"
    
    content_type = mimetypes.guess_type(filepath)[0] or "application/octet-stream"
    
    with open(filepath, "rb") as f:
        data = f.read()
    
    req = urllib.request.Request(url, data=data, headers={
        "Authorization": f"Bearer {pat}",
        "Accept": "application/vnd.github+json",
        "Content-Type": content_type,
    }, method="POST")
    
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

def delete_asset(asset_id, pat):
    url = f"https://api.github.com/repos/{REPO}/releases/assets/{asset_id}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {pat}",
        "Accept": "application/vnd.github+json",
    }, method="DELETE")
    with urllib.request.urlopen(req):
        pass

def main():
    tag = sys.argv[1] if len(sys.argv) > 1 else "v0.5.6"
    filepath = sys.argv[2] if len(sys.argv) > 2 else None
    
    pat = get_pat()
    release = get_release(tag, pat)
    print(f"Release: {release['name']} ({release['html_url']})")
    print(f"Existing assets: {len(release.get('assets', []))}")
    
    if filepath and os.path.isfile(filepath):
        # Check for duplicate
        filename = os.path.basename(filepath)
        for a in release.get("assets", []):
            if a["name"] == filename:
                print(f"Deleting existing asset: {filename}")
                delete_asset(a["id"], pat)
        
        print(f"Uploading: {filepath}")
        result = upload_asset(release, filepath, pat)
        print(f"Uploaded: {result['browser_download_url']}")
    else:
        print("Usage: python upload-release-asset.py <tag> <filepath>")

if __name__ == "__main__":
    main()
