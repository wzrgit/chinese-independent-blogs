"""
Parse README.md blog list, check each feed's last updated time and latest post title,
write results to last_updated.md.
"""

import re
import sys
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta

import urllib.request
import urllib.error
from email.utils import parsedate_to_datetime

TIMEOUT = 15
MAX_WORKERS = 20

RSS_NAMESPACES = {
    'atom': 'http://www.w3.org/2005/Atom',
    'dc': 'http://purl.org/dc/elements/1.1/',
}


def parse_readme(path='README.md'):
    """Extract rows from the blog list table in README.md."""
    entries = []
    in_table = False
    header_passed = False
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.rstrip('\n')
            if line.startswith('| RSS feed |') or line.startswith('| --- |'):
                in_table = True
                if 'RSS feed' in line:
                    header_passed = False
                else:
                    header_passed = True
                continue
            if in_table and header_passed and line.startswith('|'):
                parts = [p.strip() for p in line.split('|')]
                parts = [p for p in parts if p != '']
                if len(parts) < 4:
                    continue
                rss_cell = parts[0]
                introduction = parts[1]
                address = parts[2]
                tags = parts[3] if len(parts) > 3 else ''

                # Extract feed URL
                feed_url = None
                m = re.search(r'\[Feed\]\((.+?)\)', rss_cell, re.IGNORECASE)
                if m:
                    feed_url = m.group(1)

                entries.append({
                    'rss_cell': rss_cell,
                    'introduction': introduction,
                    'address': address,
                    'tags': tags,
                    'feed_url': feed_url,
                })
            elif in_table and not line.startswith('|'):
                in_table = False
    return entries


def format_date(date_str):
    """Parse various date formats and return yyyy/mm/dd HH:MM:SS."""
    if not date_str or date_str in ('x', '-'):
        return date_str
    formats = [
        '%Y-%m-%dT%H:%M:%S.%fZ',
        '%Y-%m-%dT%H:%M:%SZ',
        '%Y-%m-%dT%H:%M:%S%z',
        '%Y-%m-%dT%H:%M:%S.%f%z',
        '%Y-%m-%d %H:%M:%S',
        '%Y-%m-%d',
    ]
    # Try RFC 2822 (used in RSS pubDate / lastBuildDate)
    dt = None
    try:
        dt = parsedate_to_datetime(date_str)
    except Exception:
        pass
    if dt is None:
        for fmt in formats:
            try:
                dt = datetime.strptime(date_str, fmt)
                break
            except ValueError:
                continue

    if dt is None:
        return date_str  # return as-is if unparseable

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)

    # Future timestamps beyond 24h are considered invalid
    if dt > datetime.now(timezone.utc) + timedelta(hours=24):
        return 'x'

    return dt.strftime('%Y/%m/%d %H:%M:%S')


def to_datetime_utc(date_str):
    """Parse date string and return UTC datetime for comparison/sorting."""
    if not date_str or date_str in ('x', '-'):
        return None
    formats = [
        '%Y-%m-%dT%H:%M:%S.%fZ',
        '%Y-%m-%dT%H:%M:%SZ',
        '%Y-%m-%dT%H:%M:%S%z',
        '%Y-%m-%dT%H:%M:%S.%f%z',
        '%Y-%m-%d %H:%M:%S',
        '%Y-%m-%d',
    ]
    dt = None
    try:
        dt = parsedate_to_datetime(date_str)
    except Exception:
        pass
    if dt is None:
        for fmt in formats:
            try:
                dt = datetime.strptime(date_str, fmt)
                break
            except ValueError:
                continue
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def fetch_feed(url):
    """Fetch feed XML bytes. Returns (bytes, None) or (None, error_str)."""
    req = urllib.request.Request(
        url,
        headers={'User-Agent': 'Mozilla/5.0 (compatible; FeedChecker/1.0)'},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return resp.read(), None
    except Exception as e:
        return None, str(e)


def parse_feed(data):
    """Parse XML feed, return (last_updated, last_post_title)."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return None, None

    tag = root.tag.lower()

    # Atom feed: use latest entry's updated/published time.
    if 'atom' in tag or root.tag == '{http://www.w3.org/2005/Atom}feed':
        ns = 'http://www.w3.org/2005/Atom'
        entries = root.findall(f'{{{ns}}}entry')
        latest_dt = None
        latest_raw = None
        latest_title = None
        fallback_raw = None
        fallback_title = None
        for entry in entries:
            title_el = entry.find(f'{{{ns}}}title')
            title = title_el.text.strip() if title_el is not None and title_el.text else None
            upd_el = entry.find(f'{{{ns}}}updated')
            pub_el = entry.find(f'{{{ns}}}published')
            raw = None
            if upd_el is not None and upd_el.text:
                raw = upd_el.text.strip()
            elif pub_el is not None and pub_el.text:
                raw = pub_el.text.strip()
            if fallback_raw is None and raw is not None:
                fallback_raw = raw
                fallback_title = title
            dt = to_datetime_utc(raw)
            if dt is not None and (latest_dt is None or dt > latest_dt):
                latest_dt = dt
                latest_raw = raw
                latest_title = title
        if latest_raw is not None:
            return latest_raw, latest_title
        return fallback_raw, fallback_title

    # RSS 2.0: use latest item pubDate/dc:date, ignore channel lastBuildDate.
    channel = root.find('channel')
    if channel is not None:
        items = channel.findall('item')
        latest_dt = None
        latest_raw = None
        latest_title = None
        fallback_raw = None
        fallback_title = None
        for item in items:
            title_el = item.find('title')
            title = title_el.text.strip() if title_el is not None and title_el.text else None
            pub_el = item.find('pubDate')
            dc_el = item.find('{http://purl.org/dc/elements/1.1/}date')
            raw = None
            if pub_el is not None and pub_el.text:
                raw = pub_el.text.strip()
            elif dc_el is not None and dc_el.text:
                raw = dc_el.text.strip()
            if fallback_raw is None and raw is not None:
                fallback_raw = raw
                fallback_title = title
            dt = to_datetime_utc(raw)
            if dt is not None and (latest_dt is None or dt > latest_dt):
                latest_dt = dt
                latest_raw = raw
                latest_title = title
        if latest_raw is not None:
            return latest_raw, latest_title
        return fallback_raw, fallback_title

    # RSS 1.0 / RDF: use latest item dc:date.
    ns_rss = 'http://purl.org/rss/1.0/'
    ns_dc = 'http://purl.org/dc/elements/1.1/'
    items = root.findall(f'{{{ns_rss}}}item')
    latest_dt = None
    latest_raw = None
    latest_title = None
    fallback_raw = None
    fallback_title = None
    for item in items:
        title_el = item.find(f'{{{ns_rss}}}title')
        title = title_el.text.strip() if title_el is not None and title_el.text else None
        date_el = item.find(f'{{{ns_dc}}}date')
        raw = date_el.text.strip() if date_el is not None and date_el.text else None
        if fallback_raw is None and raw is not None:
            fallback_raw = raw
            fallback_title = title
        dt = to_datetime_utc(raw)
        if dt is not None and (latest_dt is None or dt > latest_dt):
            latest_dt = dt
            latest_raw = raw
            latest_title = title
    if latest_raw is not None:
        return latest_raw, latest_title
    if fallback_raw is not None:
        return fallback_raw, fallback_title

    return None, None


def check_entry(entry):
    feed_url = entry['feed_url']
    if feed_url is None:
        return entry, '-', '-'

    data, err = fetch_feed(feed_url)
    if err or data is None:
        return entry, 'x', 'x'

    updated, last_title = parse_feed(data)
    formatted_updated = format_date(updated or 'x')
    # Invalid future timestamp is treated as inaccessible.
    if formatted_updated == 'x':
        return entry, 'x', 'x'
    return entry, formatted_updated, last_title or 'x'


def escape_md(s):
    if not s:
        return ''
    return s.replace('|', '\\|')


def updated_sort_key(item):
    """Sort key for last_updated, newest first. Invalid values go to the end."""
    updated = item[1]
    try:
        dt = datetime.strptime(updated, '%Y/%m/%d %H:%M:%S')
        return 0, -dt.timestamp()
    except Exception:
        return 1, float('inf')


def write_results(path, now, results):
    lines = [
        '# Last Updated\n',
        f'> Generated at {now}\n',
        '> - `-` : no feed URL\n',
        '> - `x` : feed inaccessible or parse error\n\n',
        '| RSS feed | Introduction | Address | tags | last_updated | last_post |\n',
        '| --- | --- | --- | --- | --- | --- |\n',
    ]
    for entry, updated, last_title in results:
        rss_cell = escape_md(entry['rss_cell'])
        introduction = escape_md(entry['introduction'])
        address = escape_md(entry['address'])
        tags = escape_md(entry['tags'])
        updated_s = escape_md(str(updated)) if updated else '-'
        last_title_s = escape_md(str(last_title)) if last_title else '-'
        lines.append(f'| {rss_cell} | {introduction} | {address} | {tags} | {updated_s} | {last_title_s} |\n')

    with open(path, 'w', encoding='utf-8') as f:
        f.writelines(lines)


def main():
    print('Parsing README.md...')
    entries = parse_readme('README.md')
    print(f'Found {len(entries)} blog entries.')

    results = [None] * len(entries)

    print(f'Checking feeds with {MAX_WORKERS} workers...')
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_idx = {executor.submit(check_entry, e): i for i, e in enumerate(entries)}
        done = 0
        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            try:
                entry, updated, last_title = future.result()
            except Exception as exc:
                entry = entries[idx]
                updated, last_title = 'x', 'x'
            results[idx] = (entry, updated, last_title)
            done += 1
            if done % 50 == 0 or done == len(entries):
                print(f'  Progress: {done}/{len(entries)}')

    print('Writing last_updated.md...')
    now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    write_results('last_updated.md', now, results)

    print('Writing last_updated_sorted.md...')
    sorted_results = sorted(results, key=updated_sort_key)
    write_results('last_updated_sorted.md', now, sorted_results)

    print('Done! Results written to last_updated.md and last_updated_sorted.md')


if __name__ == '__main__':
    main()
