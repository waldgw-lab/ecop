#!/usr/bin/env python3
"""
Backup Truth Social scraper using direct API access with browser impersonation.
Fetches posts from @realDonaldTrump directly from truthsocial.com API.
Uses curl_cffi to bypass Cloudflare protection.

Trump's account ID: 107780257626128497
"""

import json
import os
import sys
import re
from datetime import datetime, timezone

TRUMP_ACCOUNT_ID = "107780257626128497"
API_BASE = "https://truthsocial.com/api/v1"


def clean_html(raw_html):
    """Remove HTML tags from content."""
    if not raw_html:
        return ""
    text = re.sub(r'<[^>]+>', '', raw_html)
    text = text.replace('&amp;', '&')
    text = text.replace('&lt;', '<')
    text = text.replace('&gt;', '>')
    text = text.replace('&quot;', '"')
    text = text.replace('&#39;', "'")
    return text.strip()


def fetch_with_curl_cffi():
    """Fetch posts using curl_cffi with browser impersonation."""
    try:
        from curl_cffi import requests as curl_requests
        
        url = f"{API_BASE}/accounts/{TRUMP_ACCOUNT_ID}/statuses?exclude_replies=true&limit=40"
        
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://truthsocial.com/@realDonaldTrump",
        }
        
        response = curl_requests.get(
            url,
            headers=headers,
            impersonate="chrome120",
            timeout=30
        )
        
        if response.status_code == 200:
            return response.json(), None
        else:
            return None, f"HTTP {response.status_code}"
            
    except ImportError:
        return None, "curl_cffi not installed"
    except Exception as e:
        return None, str(e)


def fetch_with_truthbrush():
    """Fetch posts using TruthBrush library as fallback."""
    try:
        from truthbrush import Api
        
        username = os.environ.get("TRUTHSOCIAL_USERNAME")
        password = os.environ.get("TRUTHSOCIAL_PASSWORD")
        
        if not username or not password:
            return None, "Missing credentials"
        
        api = Api(username=username, password=password)
        
        statuses = []
        for status in api.pull_statuses("realDonaldTrump", replies=False):
            statuses.append(status)
            if len(statuses) >= 40:
                break
        
        return statuses, None
        
    except Exception as e:
        error_msg = str(e)
        if "403" in error_msg:
            return None, "Blocked by Cloudflare"
        return None, error_msg


def parse_posts(data):
    """Parse API response into posts list."""
    posts = []
    
    for status in data[:50]:
        try:
            post_id = str(status.get("id", ""))
            content = clean_html(status.get("content", ""))
            
            created_at = status.get("created_at", "")
            if created_at:
                try:
                    if created_at.endswith("Z"):
                        created_at = created_at[:-1] + "+00:00"
                    posted_at = datetime.fromisoformat(created_at)
                    posted_at_iso = posted_at.isoformat()
                except:
                    posted_at_iso = created_at
            else:
                posted_at_iso = datetime.now(timezone.utc).isoformat()
            
            truth_social_url = status.get("url", f"https://truthsocial.com/@realDonaldTrump/posts/{post_id}")
            
            if post_id and (content or status.get("media_attachments")):
                posts.append({
                    "postId": post_id,
                    "content": content if content else "[Media post]",
                    "postedAt": posted_at_iso,
                    "truthSocialUrl": truth_social_url
                })
        except Exception:
            continue
    
    return posts


def fetch_trump_posts():
    """Fetch recent posts from @realDonaldTrump using multiple methods."""
    
    data, error = fetch_with_curl_cffi()
    if data is not None:
        posts = parse_posts(data)
        if posts:
            return {"error": None, "posts": posts, "source": "curl_cffi"}
    
    data, error = fetch_with_truthbrush()
    if data is not None:
        posts = parse_posts(data)
        if posts:
            return {"error": None, "posts": posts, "source": "truthbrush"}
    
    return {"error": error or "All methods failed", "posts": [], "source": None}


if __name__ == "__main__":
    import logging
    logging.getLogger("truthbrush").setLevel(logging.ERROR)
    
    result = fetch_trump_posts()
    print(json.dumps(result))
