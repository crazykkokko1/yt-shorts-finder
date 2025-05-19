import streamlit as st
import requests
import datetime
import isodate
import re

API_KEY = "AIzaSyBOOMku1-aa28MuQsJpOpxh0hrwvyvpHKo"  # 여기에 본인의 YouTube Data API 키 입력

# Streamlit 설정
st.set_page_config(page_title="🔥 지금 뜨는 유튜브 Shorts", layout="wide")
st.title(":fire: 지금 뜨는 유튜브 Shorts")

# 날짜 조건
date_option = st.radio("조회 기간 선택", ["최근 3일", "최근 7일", "틀정 날짜"])
if date_option == "틀정 날짜":
    selected_date = st.date_input("기준 날짜", datetime.date.today())
    published_after = datetime.datetime.combine(selected_date, datetime.datetime.min.time()).isoformat("T") + "Z"
else:
    days = 3 if date_option == "최근 3일" else 7
    published_after = (datetime.datetime.utcnow() - datetime.timedelta(days=days)).isoformat("T") + "Z"

# 언어 필터
exclude_korean = st.checkbox("한국어 포함 영상 제외")

# 차단 채널
blocked_ids_raw = st.text_input("차단할 채널 ID (쉼포로 구분)", "")
blocked_ids = [cid.strip() for cid in blocked_ids_raw.split(",") if cid.strip()]

# 최대 개수
max_results = st.slider("최대 결과 개수", 10, 100, 50, step=10)

# 좋아요율 높은 영상, 조회수 증가 속도 빠른 영상 필터
filter_likes = st.checkbox(":thumbsup: 좋아요율 높은 영상만 보기")
filter_velocity = st.checkbox(":rocket: 조회수 증가 속도 높은 영상만 보기")

# 정렬 기준
sort_by = st.selectbox("정렬 기준", ["조회수", "좋아요수", "업로드일"])
order_map = {
    "조회수": "viewCount",
    "좋아요수": "rating",
    "업로드일": "date"
}

# 실행 버튼
if st.button(":fire: 지금 뛰는 쇼츠"):
    st.info("YouTube Shorts 영상을 수집 중...")

    # 1단계: 검색해서 영상 ID 수집
    search_url = "https://www.googleapis.com/youtube/v3/search"
    video_ids = []
    page_token = None

    while len(video_ids) < max_results:
        params = {
            "part": "snippet",
            "maxResults": min(50, max_results - len(video_ids)),
            "order": order_map.get(sort_by, "viewCount"),
            "publishedAfter": published_after,
            "type": "video",
            "videoDuration": "short",
            "key": API_KEY
        }
        if page_token:
            params["pageToken"] = page_token

        res = requests.get(search_url, params=params).json()
        items = res.get("items", [])
        for item in items:
            video_ids.append(item["id"]["videoId"])
        page_token = res.get("nextPageToken")
        if not page_token:
            break

    st.success(f"\ud558\ub098\ub3c4 \uac80\uc0c9\ub418\ub294 ID: {len(video_ids)}")
    if not video_ids:
        st.error("YouTube API\uc5d0\uc11c \uc601\uc0c1 ID\ub97c \ucc3e\uc9c0 \ubabb\ud588\uc2b5\ub2c8\ub2e4. \ub0a0\uc9dc \ubc94\uc704 \ub610\ub294 API \ud0a4\ub97c \ud655\uc778\ud574\uc8fc\uc138\uc694.")
        st.stop()

    # 2단계: 영상 상세 정보
    video_details = []
    detail_url = "https://www.googleapis.com/youtube/v3/videos"

    for i in range(0, len(video_ids), 50):
        ids = video_ids[i:i+50]
        params = {
            "part": "snippet,statistics,contentDetails",
            "id": ",".join(ids),
            "key": API_KEY
        }
        res = requests.get(detail_url, params=params).json()
        for video in res.get("items", []):
            try:
                snippet = video["snippet"]
                stats = video["statistics"]
                details = video["contentDetails"]
                
                title = snippet["title"]
                desc = snippet.get("description", "")
                channel = snippet["channelTitle"]
                channel_id = snippet["channelId"]
                view_count = int(stats.get("viewCount", 0))
                like_count = int(stats.get("likeCount", 0)) if "likeCount" in stats else 0
                duration = isodate.parse_duration(details["duration"]).total_seconds()

                if duration > 60:
                    continue
                if exclude_korean and re.search(r"[\uac00-\ud7af]", title + desc):
                    continue
                if channel_id in blocked_ids:
                    continue
                if filter_likes and (like_count / view_count if view_count > 0 else 0) < 0.05:
                    continue
                if filter_velocity and view_count < 1000:
                    continue

                video_details.append({
                    "title": title,
                    "url": f"https://www.youtube.com/watch?v={video['id']}",
                    "views": view_count,
                    "likes": like_count,
                    "duration": int(duration),
                    "channel": channel,
                    "thumbnail": snippet["thumbnails"]["high"]["url"]
                })
            except:
                continue

    if not video_details:
        st.warning("조건에 맞는 영상이 없습니다.")
        st.stop()

    # 정렬
    if sort_by == "조회수":
        video_details.sort(key=lambda x: x["views"], reverse=True)
    elif sort_by == "좋아요수":
        video_details.sort(key=lambda x: x["likes"], reverse=True)

    # 출력
    for item in video_details:
        col1, col2 = st.columns([1, 4])
        with col1:
            st.image(item["thumbnail"], width=160)
        with col2:
            st.markdown(f"**{item['title']}**")
            st.markdown(f"조회수: {item['views']:,} / 좋아요: {item['likes']:,} / 길이: {item['duration']}초")
            st.markdown(f"채널: {item['channel']}")
            st.markdown(f"[영상 보기]({item['url']})")
        st.markdown("---")
