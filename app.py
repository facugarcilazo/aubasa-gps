# -*- coding: utf-8 -*-
import os
import uuid
from flask import Flask, render_template, request, jsonify, send_from_directory
from firebase_service import DataStore
from geo_engine import RouteCalibrator, parse_google_maps_input

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__)

store = DataStore(BASE_DIR)
routes_data = store.load_routes()
calibrator = RouteCalibrator(routes_data)


def reload_calibrator():
    global routes_data, calibrator
    routes_data = store.load_routes()
    calibrator = RouteCalibrator(routes_data)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/data/<path:filename>")
def serve_data(filename):
    return send_from_directory(os.path.join(BASE_DIR, "data"), filename)


@app.route("/api/status", methods=["GET"])
def api_status():
    summary = []
    for rcode, rdata in routes_data.items():
        cps = rdata.get("control_points", [])
        verified_count = sum(1 for c in cps if c.get("verified"))
        summary.append({
            "code": rcode,
            "name": rdata["name"],
            "short_name": rdata["short_name"],
            "color": rdata["color"],
            "control_points_count": len(cps),
            "verified_points_count": verified_count,
            "landmarks_count": len(rdata.get("landmarks", [])),
            "control_points": cps
        })
    return jsonify({
        "ok": True,
        "db_status": store.get_status(),
        "routes": summary,
        "history": store.get_search_history(limit=12)
    })


@app.route("/api/routes-geojson", methods=["GET"])
def api_routes_geojson():
    """Returns simplified polylines and control points for the interactive Leaflet map."""
    out = {}
    for rcode, rdata in routes_data.items():
        geom = rdata.get("geometry", [])
        # Downsample slightly for fast map rendering while preserving accuracy
        step = max(1, len(geom) // 600)
        sampled = geom[::step]
        if geom and sampled[-1] != geom[-1]:
            sampled.append(geom[-1])
        out[rcode] = {
            "code": rcode,
            "name": rdata["name"],
            "short_name": rdata["short_name"],
            "color": rdata["color"],
            "geometry": sampled,
            "control_points": rdata.get("control_points", [])
        }
    return jsonify({"ok": True, "routes": out})


@app.route("/api/locate", methods=["POST"])
def api_locate():
    data = request.get_json(force=True, silent=True) or {}
    raw_query = data.get("query", "").strip()
    try:
        lat, lon, resolved_url = parse_google_maps_input(raw_query)
        result = calibrator.locate(lat, lon)
        result["input_query"] = raw_query
        result["resolved_url"] = resolved_url

        # Save to history (Local + Firebase)
        store.log_search({
            "query": raw_query,
            "route_code": result["route_code"],
            "route_name": result["route_name"],
            "km_exact": result["km_exact"],
            "km_formatted": result["km_formatted"],
            "sentido_estimado": result["sentido_estimado"],
            "nearest_landmark": result["nearest_landmarks"][0]["detalle"] if result["nearest_landmarks"] else "",
            "lat": result["input_lat"],
            "lon": result["input_lon"]
        })

        return jsonify({"ok": True, "result": result})
    except ValueError as ve:
        return jsonify({"ok": False, "error": str(ve)}), 400
    except Exception as e:
        return jsonify({"ok": False, "error": f"Error al procesar la ubicación: {e}"}), 500


@app.route("/api/calibrate", methods=["POST"])
def api_calibrate():
    """
    Allows adding a new known Google Maps link + Route + KM to calibrate the route engine.
    Saves both locally and to Firebase Firestore.
    """
    data = request.get_json(force=True, silent=True) or {}
    route_code = data.get("route", "").strip().upper()
    km_raw = data.get("km")
    name = data.get("name", "").strip()
    link = data.get("link", "").strip()

    if route_code not in routes_data:
        return jsonify({"ok": False, "error": "Ruta inválida. Selecciona RP2, RP11, RP56, RP63 o RP74."}), 400

    try:
        km_val = float(str(km_raw).replace(",", "."))
    except Exception:
        return jsonify({"ok": False, "error": "Ingresa un número de kilómetro válido (ej. 122 o 145.5)."}), 400

    try:
        lat, lon, resolved_url = parse_google_maps_input(link)
    except ValueError as ve:
        return jsonify({"ok": False, "error": str(ve)}), 400

    point_obj = {
        "id": f"custom-{route_code.lower()}-km{km_val:g}-{uuid.uuid4().hex[:6]}",
        "route": route_code,
        "km": round(km_val, 2),
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "name": name or f"Referencia Calibrada KM {km_val:g}",
        "link": link,
        "resolved_url": resolved_url,
        "verified": True,
        "custom": True
    }

    store.save_custom_point(point_obj)
    reload_calibrator()

    return jsonify({
        "ok": True,
        "message": f"Punto de calibración guardado en {routes_data[route_code]['name']} KM {km_val:g}",
        "point": point_obj
    })


@app.route("/api/calibrate/<point_id>", methods=["DELETE"])
def api_delete_calibration(point_id):
    store.delete_custom_point(point_id)
    reload_calibrator()
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
