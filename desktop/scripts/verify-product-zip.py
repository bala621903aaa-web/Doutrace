"""Read-only structural and privacy check for a product-exported offline ZIP."""

import argparse
from collections import Counter
from html.parser import HTMLParser
import json
from pathlib import PurePosixPath
import sqlite3
from zipfile import ZipFile


PRIVATE_KEYS = {
    "internalPayload", "internalMediaAssets", "resourceJson", "resourceKey",
    "skey", "localPath", "nextCursor", "cookie", "authorization",
}


class OfflinePage(HTMLParser):
    def __init__(self):
        super().__init__()
        self.articles = set()
        self.searchable = 0
        self.refs = []
        self.media = []
        self.downloads = []
        self.external = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "article":
            self.articles.add(attrs.get("id"))
            self.searchable += int("data-search" in attrs)
        if tag in ("img", "audio", "video"):
            source = attrs.get("src")
            if source:
                self.media.append(source)
        if tag == "a":
            href = attrs.get("href", "")
            if "reference" in attrs.get("class", "").split():
                self.refs.append(href)
            elif href.startswith("media/") and href.lower().endswith(".heic") and "download" in attrs:
                self.downloads.append(href)
            elif href and not href.startswith("media/"):
                self.external.append(href)


def nested_keys(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from nested_keys(item)
    elif isinstance(value, list):
        for item in value:
            yield from nested_keys(item)


def verify(zip_path, database_path=None):
    with ZipFile(zip_path) as archive:
        assert archive.testzip() is None, "ZIP CRC check failed"
        names = set(archive.namelist())
        assert {"messages.json", "export-report.json", "index.html"} <= names
        assert all(not PurePosixPath(name).is_absolute() and ".." not in PurePosixPath(name).parts for name in names)
        messages_bytes = archive.read("messages.json")
        report_bytes = archive.read("export-report.json")
        html_bytes = archive.read("index.html")
        bundle = json.loads(messages_bytes)
        report = json.loads(report_bytes)
        html = html_bytes.decode("utf-8")
        rows = bundle["messages"]
        attachments = [item for row in rows for item in row["attachments"]]
        visible = [item for item in attachments if item["assetState"] != "superseded"]
        superseded = [item for item in attachments if item["assetState"] == "superseded"]
        assert report["version"] == 3
        assert len(rows) == report["messageCount"]
        assert len(visible) == report["attachmentCount"]
        assert len(superseded) == report["supersededAttachmentCount"]
        assert sum(report["contentStatusCounts"].values()) == len(rows)
        assert sum(report["attachmentStatusCounts"].values()) == len(visible)
        assert sum(report["supersededAttachmentStatusCounts"].values()) == len(superseded)
        assert report["requiredAssetMissingCount"] == len(report["requiredAssetMissing"])
        assert report["savedMediaCount"] == sum(bool(item["path"]) for item in visible)
        assert report["heicWithoutInlinePreviewCount"] == sum(bool(item["path"]) and item["mime"] == "image/heic" for item in visible)
        assert report["supersededSavedMediaCount"] == sum(bool(item["path"]) for item in superseded)
        assert report["exportedMediaFileCount"] == sum(bool(item["path"]) for item in attachments)
        assert {item["id"] for item in report["missingAttachments"]} == {item["id"] for item in visible if not item["path"]}
        assert not report["complete"] or report["historyComplete"]
        assert not (set(nested_keys(bundle)) | set(nested_keys(report))) & PRIVATE_KEYS
        assert all(not item["path"] or item["path"] in names for item in attachments)
        assert all(name == "media/" or name.startswith("media/") for name in names - {"messages.json", "export-report.json", "index.html"})

        page = OfflinePage()
        page.feed(html)
        assert len(page.articles) == page.searchable == len(rows)
        assert all(ref.startswith("#") and ref[1:] in page.articles for ref in page.refs)
        assert all(source in names for source in page.media)
        assert all(source in names for source in page.downloads)
        assert not page.external
        assert "addEventListener('input'" in html and "row.hidden" in html
        visible_paths = Counter(item["path"] for item in visible if item["path"] and item["mime"].startswith(("image/", "audio/", "video/")) and item["mime"] != "image/heic")
        assert Counter(page.media) == visible_paths
        assert Counter(page.downloads) == Counter(item["path"] for item in visible if item["path"] and item["mime"] == "image/heic")

        if database_path:
            private_text = "\n".join((messages_bytes + report_bytes + html_bytes).decode("utf-8", errors="replace").splitlines())
            connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
            try:
                for resource_json, local_path in connection.execute("SELECT resource_json, local_path FROM attachments"):
                    if local_path:
                        assert local_path not in private_text, "A local media path leaked"
                    if not resource_json:
                        continue
                    resource = json.loads(resource_json)
                    if resource.get("skey"):
                        assert resource["skey"] not in private_text, "A media key leaked"
                    for candidate in resource.get("candidates", []):
                        if candidate.get("url"):
                            assert candidate["url"] not in private_text, "A source media URL leaked"
            finally:
                connection.close()

        print(json.dumps({
            "messages": len(rows), "activeAttachments": len(visible),
            "savedMedia": report["savedMediaCount"], "inlineMedia": len(page.media), "heicDownloads": len(page.downloads),
            "references": len(page.refs), "requiredMissing": report["requiredAssetMissingCount"],
            "historyComplete": report["historyComplete"], "complete": report["complete"],
            "superseded": len(superseded), "exportedMediaFiles": report["exportedMediaFileCount"],
            "zipEntries": len(names), "privacyCheck": "passed" if database_path else "keys-only",
        }, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("zip_path")
    parser.add_argument("--database")
    args = parser.parse_args()
    verify(args.zip_path, args.database)
