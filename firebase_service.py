# -*- coding: utf-8 -*-
import os
import json
import urllib.request
from datetime import datetime, timezone

# Firebase Realtime Database URL (shared cloud instance under /aubasa_gps namespace)
DEFAULT_FIREBASE_RTDB_URL = "https://nursing-dictionary-808e3-default-rtdb.firebaseio.com/aubasa_gps"


class DataStore:
    """
    Hybrid persistence layer:
    - Synchronizes directly with Firebase Realtime Database (`DEFAULT_FIREBASE_RTDB_URL`)
    - Maintains local JSON mirror in `data/` for instant geometry loading and offline resilience.
    """
    def __init__(self, base_dir):
        self.base_dir = base_dir
        self.data_dir = os.path.join(base_dir, "data")
        os.makedirs(self.data_dir, exist_ok=True)
        self.routes_file = os.path.join(self.data_dir, "aubasa_routes.json")
        self.history_file = os.path.join(self.data_dir, "search_history.json")
        self.custom_points_file = os.path.join(self.data_dir, "custom_control_points.json")

        self.rtdb_url = (os.environ.get("FIREBASE_RTDB_URL") or DEFAULT_FIREBASE_RTDB_URL).rstrip("/")
        self.firebase_connected = True
        self.firebase_project_id = "nursing-dictionary-808e3 (aubasa_gps)"

    def _rtdb_request(self, path, method="GET", payload=None):
        url = f"{self.rtdb_url}/{path.lstrip('/')}.json"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
            method=method
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else None

    def get_status(self):
        return {
            "firebase_connected": self.firebase_connected,
            "firebase_project_id": self.firebase_project_id,
            "firebase_url": self.rtdb_url,
            "mode": "Conectado a Firebase Realtime DB" if self.firebase_connected else "Base Local JSON"
        }

    def load_routes(self):
        if not os.path.exists(self.routes_file):
            return {}
        with open(self.routes_file, "r", encoding="utf-8") as f:
            routes = json.load(f)

        # Merge any custom calibration control points from local + Firebase RTDB
        custom_pts = self.load_custom_points()
        for pt in custom_pts:
            rcode = pt.get("route")
            if rcode in routes:
                existing = routes[rcode]["control_points"]
                existing = [
                    x for x in existing
                    if x.get("id") != pt.get("id") and abs(float(x["km"]) - float(pt["km"])) > 0.05
                ]
                existing.append(pt)
                existing.sort(key=lambda x: float(x["km"]))
                routes[rcode]["control_points"] = existing

        return routes

    def load_custom_points(self):
        pts = []
        if os.path.exists(self.custom_points_file):
            try:
                with open(self.custom_points_file, "r", encoding="utf-8") as f:
                    pts = json.load(f)
            except Exception:
                pts = []

        try:
            fb_data = self._rtdb_request("custom_control_points", "GET")
            if isinstance(fb_data, dict):
                by_id = {p["id"]: p for p in pts if "id" in p}
                for k, fp in fb_data.items():
                    if isinstance(fp, dict):
                        fp["id"] = fp.get("id", k)
                        by_id[fp["id"]] = fp
                pts = list(by_id.values())
                self.firebase_connected = True
        except Exception as e:
            print(f"[Firebase RTDB] Warning reading custom_control_points: {e}")
        return pts

    def save_custom_point(self, point_data):
        safe_id = point_data["id"].replace(".", "_")
        point_data["id"] = safe_id

        pts = self.load_custom_points()
        pts = [p for p in pts if p.get("id") != safe_id]
        pts.append(point_data)
        with open(self.custom_points_file, "w", encoding="utf-8") as f:
            json.dump(pts, f, ensure_ascii=False, indent=2)

        try:
            self._rtdb_request(f"custom_control_points/{safe_id}", "PUT", point_data)
            self._rtdb_request(f"control_points/{safe_id}", "PUT", point_data)
            self.firebase_connected = True
        except Exception as e:
            print(f"[Firebase RTDB] Error saving custom point: {e}")
        return point_data

    def delete_custom_point(self, point_id):
        safe_id = point_id.replace(".", "_")
        pts = self.load_custom_points()
        pts = [p for p in pts if p.get("id") != safe_id and p.get("id") != point_id]
        with open(self.custom_points_file, "w", encoding="utf-8") as f:
            json.dump(pts, f, ensure_ascii=False, indent=2)

        try:
            self._rtdb_request(f"custom_control_points/{safe_id}", "DELETE")
            self._rtdb_request(f"control_points/{safe_id}", "DELETE")
        except Exception as e:
            print(f"[Firebase RTDB] Error deleting custom point: {e}")
        return True

    def log_search(self, entry):
        now_dt = datetime.now(timezone.utc)
        entry["timestamp"] = now_dt.isoformat()
        entry["ts_ms"] = int(now_dt.timestamp() * 1000)

        history = self._load_local_history()
        history.insert(0, entry)
        history = history[:50]
        with open(self.history_file, "w", encoding="utf-8") as f:
            json.dump(history, f, ensure_ascii=False, indent=2)

        try:
            self._rtdb_request("searches", "POST", entry)
            self.firebase_connected = True
        except Exception as e:
            print(f"[Firebase RTDB] Error logging search: {e}")

    def _load_local_history(self):
        if os.path.exists(self.history_file):
            try:
                with open(self.history_file, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                return []
        return []

    def get_search_history(self, limit=15):
        try:
            fb_searches = self._rtdb_request("searches", "GET")
            if isinstance(fb_searches, dict):
                items = list(fb_searches.values())
                items.sort(key=lambda x: x.get("ts_ms", 0), reverse=True)
                self.firebase_connected = True
                return items[:limit]
        except Exception as e:
            print(f"[Firebase RTDB] Warning reading searches: {e}")
        return self._load_local_history()[:limit]
