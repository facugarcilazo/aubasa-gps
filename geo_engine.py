# -*- coding: utf-8 -*-
import re
import math
import urllib.request
import urllib.parse

def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0088
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2
    return 2.0 * R * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))

def parse_google_maps_input(raw_input):
    """
    Extracts (lat, lon, resolved_url) from:
    - Short URLs: https://maps.app.goo.gl/... or https://goo.gl/maps/...
    - Full Google Maps URLs: !3d-35.307!4d-58.053, @-35.307,-58.053, ?q=-35.307,-58.053, /search/-36.323,+-57.695
    - Direct coordinate strings: "-35.3076, -58.0536"
    """
    if not raw_input or not raw_input.strip():
        raise ValueError("Por favor ingresa un link de Google Maps o coordenadas.")

    text = raw_input.strip()
    resolved_url = text

    # 1. Check if direct coordinates were pasted (e.g. "-35.3076, -58.0536")
    direct_match = re.match(r'^(-?\d{1,2}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)$', text)
    if direct_match:
        lat, lon = float(direct_match.group(1)), float(direct_match.group(2))
        return lat, lon, f"https://www.google.com/maps?q={lat},{lon}"

    # 2. Extract URL if embedded inside WhatsApp message text (e.g. "Ubicación: https://maps.app.goo.gl/...")
    url_match = re.search(r'(https?://[^\s]+)', text)
    if url_match:
        resolved_url = url_match.group(1)

    # 3. If it's a shortened link, follow HTTP redirects to get the full URL
    if any(domain in resolved_url.lower() for domain in ["goo.gl", "maps.app.goo.gl", "bit.ly", "tinyurl.com"]):
        try:
            req = urllib.request.Request(
                resolved_url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
                }
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                resolved_url = resp.geturl()
        except Exception as e:
            raise ValueError(f"No se pudo expandir el link corto de Google Maps ({e}). Verifica tu conexión o pega el link completo.")

    decoded_url = urllib.parse.unquote(resolved_url)

    # 4. Priority extraction patterns on decoded_url:
    # Pattern A: /search/-36.323511,+-57.695559 or ?q=-36.323511,-57.695559 or &ll=-36.323511,-57.695559
    m_search = re.search(r'(?:search/|q=|ll=|query=)(-?\d{1,2}\.\d+)\s*[,+]\s*\+?(-?\d{1,3}\.\d+)', decoded_url)
    if m_search:
        return float(m_search.group(1)), float(m_search.group(2)), resolved_url

    # Pattern B:/@lat,lon (Wait! If it's a StreetView link like /@-34.8995,-58.1723,28a... the camera is @lat,lon!
    # Whereas if it's a place pin, !3dlat!4dlon is the pin. However, in StreetView links where someone clicked a place name
    # 40km away, @lat,lon is the exact camera position! Let's check if it's StreetView (,28a, or !1e1!3m5))
    is_streetview = ",3a," in decoded_url or "a,75y" in decoded_url or "!1e1!" in decoded_url
    m_at = re.search(r'@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)', decoded_url)
    m_3d = re.findall(r'!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)', decoded_url)

    if is_streetview and m_at:
        return float(m_at.group(1)), float(m_at.group(2)), resolved_url

    if m_3d:
        # Take the last !3d...!4d... which is the actual selected marker
        lat, lon = float(m_3d[-1][0]), float(m_3d[-1][1])
        return lat, lon, resolved_url

    if m_at:
        return float(m_at.group(1)), float(m_at.group(2)), resolved_url

    # Pattern C: Any pair of Argentina-range coordinates (-30 to -42 lat, -55 to -65 lon)
    m_any = re.search(r'(-3[3-9]\.\d+)\s*[,;/\s+]\s*(-5[6-9]\.\d+)', decoded_url)
    if m_any:
        return float(m_any.group(1)), float(m_any.group(2)), resolved_url

    raise ValueError("No se encontraron coordenadas geográficas válidas en el link ingresado.")


def project_point_on_segment(px, py, ax, ay, bx, by):
    """
    Projects point P(px, py) onto segment AB(ax, ay -> bx, by) in local equirectangular coordinates.
    Returns (proj_lat, proj_lon, t_clamped, dist_km, signed_cross_product)
    """
    cos_lat = math.cos(math.radians((ax + bx + px) / 3.0))
    # Scale lon by cos_lat to work in isotropic degrees
    x_p, y_p = py * cos_lat, px
    x_a, y_a = ay * cos_lat, ax
    x_b, y_b = by * cos_lat, bx

    dx = x_b - x_a
    dy = y_b - y_a
    seg_len_sq = dx * dx + dy * dy

    if seg_len_sq < 1e-14:
        t = 0.0
    else:
        t = ((x_p - x_a) * dx + (y_p - y_a) * dy) / seg_len_sq
        t = max(0.0, min(1.0, t))

    proj_lat = ax + t * (bx - ax)
    proj_lon = ay + t * (by - ay)
    dist_km = haversine_km(px, py, proj_lat, proj_lon)

    # Cross product in 2D: vector AB = (dx, dy), vector AP = (x_p - x_a, y_p - y_a)
    # In (East=X, North=Y): cross = dx * (y_p - y_a) - dy * (x_p - x_a)
    # Positive means P is to the LEFT of the travel direction A->B; Negative means RIGHT.
    cross = dx * (y_p - y_a) - dy * (x_p - x_a)
    return proj_lat, proj_lon, t, dist_km, cross


class RouteCalibrator:
    """
    Precomputes cumulative distances along each route's polyline and calibrates
    every vertex's exact KM progression using the route's control points (piecewise linear calibration).
    """
    def __init__(self, routes_data):
        self.routes = routes_data
        self.calibrated_polylines = {}
        self._calibrate_all()

    def _calibrate_all(self):
        for rcode, rdata in self.routes.items():
            geom = rdata.get("geometry", [])
            if len(geom) < 2:
                continue

            # 1. Cumulative geometric distance along polyline
            cum_dist = [0.0]
            for i in range(1, len(geom)):
                d = haversine_km(geom[i - 1][0], geom[i - 1][1], geom[i][0], geom[i][1])
                cum_dist.append(cum_dist[-1] + d)

            # 2. Project each control point onto the polyline to get its geometric distance `s`
            cps = sorted(rdata.get("control_points", []), key=lambda c: float(c["km"]))
            cp_projections = []
            for cp in cps:
                c_lat, c_lon, c_km = float(cp["lat"]), float(cp["lon"]), float(cp["km"])
                best_s = 0.0
                best_d = float("inf")
                for i in range(len(geom) - 1):
                    _, _, t, d, _ = project_point_on_segment(
                        c_lat, c_lon, geom[i][0], geom[i][1], geom[i + 1][0], geom[i + 1][1]
                    )
                    if d < best_d:
                        best_d = d
                        seg_len = cum_dist[i + 1] - cum_dist[i]
                        best_s = cum_dist[i] + t * seg_len
                cp_projections.append({"s": best_s, "km": c_km, "cp": cp})

            # Ensure monotonic s
            cp_projections.sort(key=lambda x: x["s"])

            # 3. Assign calibrated KM to every vertex in geom
            vertex_kms = []
            for s in cum_dist:
                vertex_kms.append(self._interpolate_km(s, cp_projections))

            # 4. Also assign approximate lat/lon to every landmark from CSV for map display
            for lm in rdata.get("landmarks", []):
                lm_km = float(lm["km"])
                lat_lm, lon_lm = self.km_to_coords_raw(geom, vertex_kms, lm_km)
                lm["lat"] = round(lat_lm, 6)
                lm["lon"] = round(lon_lm, 6)

            self.calibrated_polylines[rcode] = {
                "geom": geom,
                "cum_dist": cum_dist,
                "vertex_kms": vertex_kms,
                "cp_projections": cp_projections
            }

    @staticmethod
    def _interpolate_km(s, cp_projections):
        if not cp_projections:
            return s
        if len(cp_projections) == 1:
            p0 = cp_projections[0]
            return p0["km"] + (s - p0["s"])

        if s <= cp_projections[0]["s"]:
            p0, p1 = cp_projections[0], cp_projections[1]
            ds = p1["s"] - p0["s"]
            slope = (p1["km"] - p0["km"]) / ds if ds > 1e-6 else 1.0
            return p0["km"] + (s - p0["s"]) * slope

        if s >= cp_projections[-1]["s"]:
            p0, p1 = cp_projections[-2], cp_projections[-1]
            ds = p1["s"] - p0["s"]
            slope = (p1["km"] - p0["km"]) / ds if ds > 1e-6 else 1.0
            return p1["km"] + (s - p1["s"]) * slope

        for i in range(len(cp_projections) - 1):
            p0, p1 = cp_projections[i], cp_projections[i + 1]
            if p0["s"] <= s <= p1["s"]:
                ds = p1["s"] - p0["s"]
                if ds < 1e-6:
                    return p0["km"]
                ratio = (s - p0["s"]) / ds
                return p0["km"] + ratio * (p1["km"] - p0["km"])
        return cp_projections[-1]["km"]

    @staticmethod
    def km_to_coords_raw(geom, vertex_kms, target_km):
        if not geom:
            return (-36.0, -57.5)
        if target_km <= vertex_kms[0]:
            return geom[0]
        if target_km >= vertex_kms[-1]:
            return geom[-1]
        for i in range(len(vertex_kms) - 1):
            k0, k1 = vertex_kms[i], vertex_kms[i + 1]
            if (k0 <= target_km <= k1) or (k1 <= target_km <= k0):
                dk = k1 - k0
                t = (target_km - k0) / dk if abs(dk) > 1e-6 else 0.0
                lat = geom[i][0] + t * (geom[i + 1][0] - geom[i][0])
                lon = geom[i][1] + t * (geom[i + 1][1] - geom[i][1])
                return [lat, lon]
        return geom[0]

    def locate(self, lat, lon):
        """
        Finds the closest AUBASA route, exact calibrated KM, estimated carriageway direction,
        and nearest landmarks (excluding SOS posts by default, or showing them as secondary).
        """
        best_match = None

        for rcode, cal in self.calibrated_polylines.items():
            geom = cal["geom"]
            cum_dist = cal["cum_dist"]
            cp_proj = cal["cp_projections"]

            min_d = float("inf")
            best_seg = 0
            best_t = 0.0
            best_proj = (geom[0][0], geom[0][1])
            best_cross = 0.0

            for i in range(len(geom) - 1):
                p_lat, p_lon, t, d, cross = project_point_on_segment(
                    lat, lon, geom[i][0], geom[i][1], geom[i + 1][0], geom[i + 1][1]
                )
                if d < min_d:
                    min_d = d
                    best_seg = i
                    best_t = t
                    best_proj = (p_lat, p_lon)
                    best_cross = cross

            seg_len = cum_dist[best_seg + 1] - cum_dist[best_seg]
            s_exact = cum_dist[best_seg] + best_t * seg_len
            km_exact = self._interpolate_km(s_exact, cp_proj)

            if best_match is None or min_d < best_match["distance_to_route_km"]:
                best_match = {
                    "route_code": rcode,
                    "distance_to_route_km": min_d,
                    "km_exact": km_exact,
                    "snapped_lat": best_proj[0],
                    "snapped_lon": best_proj[1],
                    "cross": best_cross,
                    "s_exact": s_exact
                }

        if not best_match:
            raise ValueError("No hay rutas cargadas para calcular la ubicación.")

        rcode = best_match["route_code"]
        rdata = self.routes[rcode]
        km_exact = round(best_match["km_exact"], 2)
        km_int = int(round(km_exact))
        meters_offset = int(round((km_exact - math.floor(km_exact)) * 1000))

        # Estimate carriageway direction based on lateral offset from the reference polyline:
        # In Argentina traffic drives on the right.
        # Since our polylines are traced in Ascending KM order (A -> B),
        # a point to the right of A->B (cross < 0) tends to be Ascending, and to the left (cross > 0) Descending.
        # If the pin is right on the centerline (< 6 meters), we mark it as "Ambos sentidos / Sobre traza".
        dist_m = round(best_match["distance_to_route_km"] * 1000)
        if dist_m <= 5:
            sentido_estimado = "Sobre traza principal (Verificar mano)"
            sentido_code = "AMBOS"
        elif best_match["cross"] <= 0:
            sentido_estimado = rdata.get("asc_label", "Ascendente")
            sentido_code = "ASC"
        else:
            sentido_estimado = rdata.get("desc_label", "Descendente")
            sentido_code = "DESC"

        # Find nearest landmarks from the Excel list (prioritizing real landmarks over SOS posts)
        all_landmarks = rdata.get("landmarks", [])
        physical_landmarks = [lm for lm in all_landmarks if not lm.get("is_sos", False)]
        sos_landmarks = [lm for lm in all_landmarks if lm.get("is_sos", False)]

        def enrich_landmark(lm):
            diff_km = lm["km"] - km_exact
            abs_diff_km = abs(diff_km)
            dist_str = f"{int(round(abs_diff_km * 1000))} m" if abs_diff_km < 1.0 else f"{abs_diff_km:.1f} km"
            if abs_diff_km < 0.08:
                rel_pos = "En el lugar"
            elif diff_km > 0:
                rel_pos = f"{dist_str} más adelante (hacia KM {lm['km_label']})"
            else:
                rel_pos = f"{dist_str} atrás (en KM {lm['km_label']})"
            return {
                **lm,
                "abs_diff_km": round(abs_diff_km, 2),
                "dist_label": dist_str,
                "rel_pos": rel_pos
            }

        nearest_physical = sorted([enrich_landmark(x) for x in physical_landmarks], key=lambda x: x["abs_diff_km"])[:4]
        nearest_sos = sorted([enrich_landmark(x) for x in sos_landmarks], key=lambda x: x["abs_diff_km"])[:2]

        # Find which two control points bracket this location
        cps = sorted(rdata.get("control_points", []), key=lambda x: float(x["km"]))
        prev_cp = cps[0]
        next_cp = cps[-1]
        for cp in cps:
            if float(cp["km"]) <= km_exact:
                prev_cp = cp
            if float(cp["km"]) >= km_exact:
                next_cp = cp
                break

        off_route_warning = None
        if best_match["distance_to_route_km"] > 2.5:
            off_route_warning = (
                f"Atención: La ubicación está a {best_match['distance_to_route_km']:.2f} km "
                f"de la traza de {rdata['name']}. Verifica si el usuario se encuentra en un camino secundario o localidad aledaña."
            )

        return {
            "route_code": rcode,
            "route_name": rdata["name"],
            "route_short": rdata["short_name"],
            "route_color": rdata["color"],
            "km_exact": km_exact,
            "km_formatted": f"KM {km_exact:.1f}".replace(".0", ""),
            "km_progressive": f"{int(math.floor(km_exact))} + {meters_offset:03d} m",
            "km_integer": km_int,
            "input_lat": round(lat, 6),
            "input_lon": round(lon, 6),
            "snapped_lat": round(best_match["snapped_lat"], 6),
            "snapped_lon": round(best_match["snapped_lon"], 6),
            "distance_to_route_m": dist_m,
            "distance_to_route_km": round(best_match["distance_to_route_km"], 3),
            "sentido_estimado": sentido_estimado,
            "sentido_code": sentido_code,
            "asc_label": rdata.get("asc_label", "Ascendente"),
            "desc_label": rdata.get("desc_label", "Descendente"),
            "nearest_landmarks": nearest_physical,
            "nearest_sos": nearest_sos,
            "prev_control_point": prev_cp,
            "next_control_point": next_cp,
            "off_route_warning": off_route_warning
        }
