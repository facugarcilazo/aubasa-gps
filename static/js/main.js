// AUBASA GPS · Frontend + Client-Side Geo Engine + Firebase RTDB Sync
// Works both with the Python Flask server AND 100% standalone on GitHub Pages (.github.io)

const FIREBASE_RTDB_URL = "https://nursing-dictionary-808e3-default-rtdb.firebaseio.com/aubasa_gps";
const IS_STATIC_HOST = window.location.hostname.endsWith("github.io") || window.location.protocol === "file:";

let map = null;
let routeLayers = {};
let controlMarkersLayer = null;
let userPinMarker = null;
let snappedPinMarker = null;
let snapLine = null;
let lastLocateResult = null;
let clientRoutesData = null;
let clientCalibratedPolylines = null;

document.addEventListener("DOMContentLoaded", async () => {
    initMap();
    bindEvents();
    await initDataAndRender();
});

function initMap() {
    map = L.map("corridorMap", {
        zoomControl: true,
        attributionControl: true
    }).setView([-36.35, -57.55], 7);

    const osmCallejero = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · AUBASA'
    });

    const esriSatelite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19,
        attribution: '&copy; Esri · AUBASA'
    });

    osmCallejero.addTo(map);
    L.control.layers({
        "Mapa Vial (OSM)": osmCallejero,
        "Vista Satélite": esriSatelite
    }, null, { position: "topright" }).addTo(map);

    controlMarkersLayer = L.layerGroup().addTo(map);

    map.on("click", (e) => {
        const lat = e.latlng.lat.toFixed(6);
        const lon = e.latlng.lng.toFixed(6);
        const coordQuery = `${lat}, ${lon}`;
        document.getElementById("mapsInput").value = coordQuery;
        document.getElementById("clearBtn").classList.remove("hidden");
        runLocateQuery(coordQuery);
    });
}

// ============================================================================
// Client-side Haversine & Piecewise Route Calibration (for GitHub Pages / fallback)
// ============================================================================
function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371.0088;
    const toRad = d => (d * Math.PI) / 180.0;
    const phi1 = toRad(lat1), phi2 = toRad(lat2);
    const dphi = toRad(lat2 - lat1);
    const dlambda = toRad(lon2 - lon1);
    const a = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function projectPointOnSegment(px, py, ax, ay, bx, by) {
    const cosLat = Math.cos(((ax + bx + px) / 3.0) * (Math.PI / 180.0));
    const xp = py * cosLat, yp = px;
    const xa = ay * cosLat, ya = ax;
    const xb = by * cosLat, yb = bx;
    const dx = xb - xa, dy = yb - ya;
    const segLenSq = dx * dx + dy * dy;
    let t = 0.0;
    if (segLenSq >= 1e-14) {
        t = ((xp - xa) * dx + (yp - ya) * dy) / segLenSq;
        t = Math.max(0.0, Math.min(1.0, t));
    }
    const projLat = ax + t * (bx - ax);
    const projLon = ay + t * (by - ay);
    const distKm = haversineKm(px, py, projLat, projLon);
    const cross = dx * (yp - ya) - dy * (xp - xa);
    return { projLat, projLon, t, distKm, cross };
}

function interpolateKm(s, cpProjections) {
    if (!cpProjections || !cpProjections.length) return s;
    if (cpProjections.length === 1) return cpProjections[0].km + (s - cpProjections[0].s);
    if (s <= cpProjections[0].s) {
        const p0 = cpProjections[0], p1 = cpProjections[1];
        const ds = p1.s - p0.s;
        const slope = ds > 1e-6 ? (p1.km - p0.km) / ds : 1.0;
        return p0.km + (s - p0.s) * slope;
    }
    const lastIdx = cpProjections.length - 1;
    if (s >= cpProjections[lastIdx].s) {
        const p0 = cpProjections[lastIdx - 1], p1 = cpProjections[lastIdx];
        const ds = p1.s - p0.s;
        const slope = ds > 1e-6 ? (p1.km - p0.km) / ds : 1.0;
        return p1.km + (s - p1.s) * slope;
    }
    for (let i = 0; i < lastIdx; i++) {
        const p0 = cpProjections[i], p1 = cpProjections[i + 1];
        if (s >= p0.s && s <= p1.s) {
            const ds = p1.s - p0.s;
            if (ds < 1e-6) return p0.km;
            return p0.km + ((s - p0.s) / ds) * (p1.km - p0.km);
        }
    }
    return cpProjections[lastIdx].km;
}

function buildClientCalibrator(routes) {
    const calibrated = {};
    Object.entries(routes).forEach(([rcode, rdata]) => {
        const geom = rdata.geometry || [];
        if (geom.length < 2) return;
        const cumDist = [0.0];
        for (let i = 1; i < geom.length; i++) {
            cumDist.push(cumDist[i - 1] + haversineKm(geom[i - 1][0], geom[i - 1][1], geom[i][0], geom[i][1]));
        }
        const cps = [...(rdata.control_points || [])].sort((a, b) => Number(a.km) - Number(b.km));
        const cpProjections = cps.map(cp => {
            let bestS = 0.0, bestD = Infinity;
            for (let i = 0; i < geom.length - 1; i++) {
                const { t, distKm } = projectPointOnSegment(
                    Number(cp.lat), Number(cp.lon),
                    geom[i][0], geom[i][1], geom[i + 1][0], geom[i + 1][1]
                );
                if (distKm < bestD) {
                    bestD = distKm;
                    bestS = cumDist[i] + t * (cumDist[i + 1] - cumDist[i]);
                }
            }
            return { s: bestS, km: Number(cp.km), cp };
        }).sort((a, b) => a.s - b.s);

        calibrated[rcode] = { geom, cumDist, cpProjections };
    });
    return calibrated;
}

async function parseGoogleMapsClient(rawInput) {
    const text = (rawInput || "").trim();
    if (!text) throw new Error("Por favor ingresa un link de Google Maps o coordenadas.");

    const directMatch = text.match(/^(-?\d{1,2}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)$/);
    if (directMatch) {
        const lat = parseFloat(directMatch[1]), lon = parseFloat(directMatch[2]);
        return { lat, lon, resolvedUrl: `https://www.google.com/maps?q=${lat},${lon}` };
    }

    let url = text;
    const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
    if (urlMatch) url = urlMatch[1];

    // If short link on static host (GitHub Pages), resolve via multi-stage CORS-enabled unshorteners + Firebase cache
    if (/goo\.gl|maps\.app\.goo\.gl|bit\.ly|tinyurl\.com/i.test(url)) {
        // 1. Check if this link matches any already-verified control point in clientRoutesData
        if (clientRoutesData) {
            for (const r of Object.values(clientRoutesData)) {
                for (const cp of (r.control_points || [])) {
                    if (cp.link && cp.link.trim() === url.trim()) {
                        return { lat: Number(cp.lat), lon: Number(cp.lon), resolvedUrl: url };
                    }
                }
            }
        }

        // 2. Check Firebase RTDB cache of previously resolved short links
        const urlHashKey = url.replace(/[^a-zA-Z0-9_-]/g, "_");
        try {
            const cacheResp = await fetch(`${FIREBASE_RTDB_URL}/resolved_links/${urlHashKey}.json`);
            if (cacheResp.ok) {
                const cached = await cacheResp.json();
                if (cached && typeof cached.lat === "number" && typeof cached.lon === "number") {
                    return { lat: cached.lat, lon: cached.lon, resolvedUrl: cached.resolvedUrl || url };
                }
            }
        } catch (e) {}

        // 3. Primary Resolver: r.jina.ai (CORS=*, fast, returns either DMS Title "37°06'04.2\"S 56°55'04.0\"W" or "Final URL: https://...")
        let resolvedCandidate = null;
        try {
            const jinaResp = await fetch(`https://r.jina.ai/${url}`);
            if (jinaResp.ok) {
                const jinaText = await jinaResp.text();

                // Check if Jina Title has exact DMS coordinates (e.g. Title: 37°06'04.2"S 56°55'04.0"W)
                const dmsMatch = jinaText.match(/(\d{1,2})\s*°\s*(\d{1,2})\s*['’]\s*(\d{1,2}(?:\.\d+)?)\s*["”]\s*([NSns])\s*[,;\s]+\s*(\d{1,3})\s*°\s*(\d{1,2})\s*['’]\s*(\d{1,2}(?:\.\d+)?)\s*["”]\s*([EWewOo])/);
                if (dmsMatch) {
                    let latDms = parseInt(dmsMatch[1], 10) + parseInt(dmsMatch[2], 10) / 60.0 + parseFloat(dmsMatch[3]) / 3600.0;
                    if (dmsMatch[4].toUpperCase() === "S") latDms = -latDms;
                    let lonDms = parseInt(dmsMatch[5], 10) + parseInt(dmsMatch[6], 10) / 60.0 + parseFloat(dmsMatch[7]) / 3600.0;
                    if (dmsMatch[8].toUpperCase() === "W" || dmsMatch[8].toUpperCase() === "O") lonDms = -lonDms;
                    resolvedCandidate = `https://www.google.com/maps/search/${latDms.toFixed(6)},${lonDms.toFixed(6)}`;
                } else {
                    const gmapMatch = jinaText.match(/https?:\/\/(?:www\.)?google\.com\/maps\/[^\s"'\r\n<>]+/i);
                    if (gmapMatch) {
                        resolvedCandidate = gmapMatch[0];
                    } else {
                        const decInJina = jinaText.match(/(-3[3-9]\.\d{4,})\s*[,;+\s]\s*\+?(-5[6-9]\.\d{4,})/);
                        if (decInJina) {
                            resolvedCandidate = `https://www.google.com/maps/search/${decInJina[1]},${decInJina[2]}`;
                        }
                    }
                }
            }
        } catch (e) {
            console.warn("Jina resolver warning:", e);
        }

        // 4. Secondary Resolver: unshorten.me JSON API (NOTE: must pass raw url in path, NOT encodeURIComponent!)
        if (!resolvedCandidate) {
            try {
                const unResp = await fetch(`https://unshorten.me/json/${url}`);
                if (unResp.ok) {
                    const unData = await unResp.json();
                    if (unData && unData.resolved_url) {
                        resolvedCandidate = unData.resolved_url;
                    }
                }
            } catch (e) {
                console.warn("unshorten.me warning:", e);
            }
        }

        // 5. Tertiary Resolver: api.cors.lol HTML body inspection
        if (!resolvedCandidate) {
            try {
                const lolResp = await fetch(`https://api.cors.lol/?url=${encodeURIComponent(url)}`);
                if (lolResp.ok) {
                    const htmlText = await lolResp.text();
                    const gmapMatch = htmlText.match(/https?:\/\/(?:www\.)?google\.com\/maps\/[^\s"'\r\n<>\\]+/i);
                    if (gmapMatch) {
                        resolvedCandidate = gmapMatch[0];
                    } else {
                        const coordInHtml = htmlText.match(/(-3[3-9]\.\d{4,})\s*[,;+]\s*(-5[6-9]\.\d{4,})/);
                        if (coordInHtml) {
                            resolvedCandidate = `https://www.google.com/maps/search/${coordInHtml[1]},${coordInHtml[2]}`;
                        }
                    }
                }
            } catch (e) {
                console.warn("cors.lol warning:", e);
            }
        }

        if (resolvedCandidate) {
            url = resolvedCandidate;
        }

        // 6. Unwrap Google consent wrapper if present (e.g. consent.google.com/ml?continue=https%3A%2F%2Fwww.google.com%2Fmaps...)
        if (url.includes("continue=")) {
            try {
                const uObj = new URL(url);
                const cont = uObj.searchParams.get("continue");
                if (cont) url = decodeURIComponent(cont);
            } catch (e) {}
        }
    }

    const originalShortUrl = url;
    // Decode up to twice in case of nested URL encoding
    const decoded = decodeURIComponent(decodeURIComponent(url));
    let parsedCoord = null;
    const mSearch = decoded.match(/(?:search\/|place\/|q=|ll=|query=)(-?\d{1,2}\.\d+)\s*[,+]\s*\+?(-?\d{1,3}\.\d+)/);
    if (mSearch) {
        parsedCoord = { lat: parseFloat(mSearch[1]), lon: parseFloat(mSearch[2]), resolvedUrl: url };
    } else {
        const dmsDirect = decoded.match(/(\d{1,2})\s*°\s*(\d{1,2})\s*['’]\s*(\d{1,2}(?:\.\d+)?)\s*["”]\s*([NSns])\s*[,;+\s]+\s*(\d{1,3})\s*°\s*(\d{1,2})\s*['’]\s*(\d{1,2}(?:\.\d+)?)\s*["”]\s*([EWewOo])/);
        if (dmsDirect) {
            let latDms = parseInt(dmsDirect[1], 10) + parseInt(dmsDirect[2], 10) / 60.0 + parseFloat(dmsDirect[3]) / 3600.0;
            if (dmsDirect[4].toUpperCase() === "S") latDms = -latDms;
            let lonDms = parseInt(dmsDirect[5], 10) + parseInt(dmsDirect[6], 10) / 60.0 + parseFloat(dmsDirect[7]) / 3600.0;
            if (dmsDirect[8].toUpperCase() === "W" || dmsDirect[8].toUpperCase() === "O") lonDms = -lonDms;
            parsedCoord = { lat: Number(latDms.toFixed(6)), lon: Number(lonDms.toFixed(6)), resolvedUrl: url };
        }
    }
    if (!parsedCoord) {
        const isStreetView = decoded.includes(",3a,") || decoded.includes("a,75y") || decoded.includes("!1e1!");
        const mAt = decoded.match(/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/);
        const m3dAll = [...decoded.matchAll(/!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/g)];

        if (isStreetView && mAt) {
            parsedCoord = { lat: parseFloat(mAt[1]), lon: parseFloat(mAt[2]), resolvedUrl: url };
        } else if (m3dAll.length > 0) {
            const last = m3dAll[m3dAll.length - 1];
            parsedCoord = { lat: parseFloat(last[1]), lon: parseFloat(last[2]), resolvedUrl: url };
        } else if (mAt) {
            parsedCoord = { lat: parseFloat(mAt[1]), lon: parseFloat(mAt[2]), resolvedUrl: url };
        } else {
            const mAny = decoded.match(/(-3[3-9]\.\d+)\s*[,;/\s+]\s*(-5[6-9]\.\d+)/);
            if (mAny) parsedCoord = { lat: parseFloat(mAny[1]), lon: parseFloat(mAny[2]), resolvedUrl: url };
        }
    }

    if (parsedCoord) {
        // Save resolved short link to Firebase RTDB cache so future lookups are instant
        try {
            const rawShortMatch = text.match(/(https?:\/\/[^\s]+)/);
            if (rawShortMatch && /goo\.gl|maps\.app\.goo\.gl/i.test(rawShortMatch[1])) {
                const hashKey = rawShortMatch[1].replace(/[^a-zA-Z0-9_-]/g, "_");
                fetch(`${FIREBASE_RTDB_URL}/resolved_links/${hashKey}.json`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(parsedCoord)
                }).catch(() => {});
            }
        } catch (e) {}
        return parsedCoord;
    }

    throw new Error("No se pudieron extraer las coordenadas del link corto en modo estático. Abre el link y copia la URL completa o las coordenadas.");
}

function locateClient(lat, lon) {
    let bestMatch = null;
    Object.entries(clientCalibratedPolylines).forEach(([rcode, cal]) => {
        const { geom, cumDist, cpProjections } = cal;
        let minD = Infinity, bestSeg = 0, bestT = 0, bestProj = geom[0], bestCross = 0;
        for (let i = 0; i < geom.length - 1; i++) {
            const { projLat, projLon, t, distKm, cross } = projectPointOnSegment(
                lat, lon, geom[i][0], geom[i][1], geom[i + 1][0], geom[i + 1][1]
            );
            if (distKm < minD) {
                minD = distKm;
                bestSeg = i;
                bestT = t;
                bestProj = [projLat, projLon];
                bestCross = cross;
            }
        }
        const sExact = cumDist[bestSeg] + bestT * (cumDist[bestSeg + 1] - cumDist[bestSeg]);
        const kmExact = interpolateKm(sExact, cpProjections);
        if (!bestMatch || minD < bestMatch.distance_to_route_km) {
            bestMatch = {
                route_code: rcode,
                distance_to_route_km: minD,
                km_exact: kmExact,
                snapped_lat: bestProj[0],
                snapped_lon: bestProj[1],
                cross: bestCross
            };
        }
    });

    const rcode = bestMatch.route_code;
    const rdata = clientRoutesData[rcode];
    const kmExact = Math.round(bestMatch.km_exact * 100) / 100;
    const metersOffset = Math.round((kmExact - Math.floor(kmExact)) * 1000);
    const distM = Math.round(bestMatch.distance_to_route_km * 1000);

    let sentidoEstimado = "Sobre traza principal (Verificar mano)";
    if (distM > 5) {
        sentidoEstimado = bestMatch.cross <= 0 ? rdata.asc_label : rdata.desc_label;
    }

    const physicalLandmarks = (rdata.landmarks || []).filter(lm => !lm.is_sos);
    const nearestPhysical = physicalLandmarks.map(lm => {
        const diffKm = lm.km - kmExact;
        const absDiff = Math.abs(diffKm);
        const distStr = absDiff < 1.0 ? `${Math.round(absDiff * 1000)} m` : `${absDiff.toFixed(1)} km`;
        const relPos = absDiff < 0.08 ? "En el lugar" : (diffKm > 0 ? `${distStr} más adelante (hacia KM ${lm.km_label})` : `${distStr} atrás (en KM ${lm.km_label})`);
        return { ...lm, abs_diff_km: absDiff, rel_pos: relPos };
    }).sort((a, b) => a.abs_diff_km - b.abs_diff_km).slice(0, 4);

    const cps = [...(rdata.control_points || [])].sort((a, b) => a.km - b.km);
    let prevCp = cps[0], nextCp = cps[cps.length - 1];
    for (const cp of cps) {
        if (cp.km <= kmExact) prevCp = cp;
        if (cp.km >= kmExact) { nextCp = cp; break; }
    }

    return {
        route_code: rcode,
        route_name: rdata.name,
        route_short: rdata.short_name,
        route_color: rdata.color,
        km_exact: kmExact,
        km_formatted: `KM ${kmExact.toFixed(1)}`.replace(".0", ""),
        km_progressive: `${Math.floor(kmExact)} + ${String(metersOffset).padStart(3, "0")} m`,
        input_lat: Number(lat.toFixed(6)),
        input_lon: Number(lon.toFixed(6)),
        snapped_lat: Number(bestMatch.snapped_lat.toFixed(6)),
        snapped_lon: Number(bestMatch.snapped_lon.toFixed(6)),
        distance_to_route_m: distM,
        distance_to_route_km: Number(bestMatch.distance_to_route_km.toFixed(3)),
        sentido_estimado: sentidoEstimado,
        nearest_landmarks: nearestPhysical,
        prev_control_point: prevCp,
        next_control_point: nextCp,
        off_route_warning: bestMatch.distance_to_route_km > 2.5
            ? `Atención: La ubicación está a ${bestMatch.distance_to_route_km.toFixed(2)} km de la traza de ${rdata.name}.`
            : null
    };
}

// ============================================================================
// Data Initialization (Flask API + Firebase RTDB + Static JSON Fallback)
// ============================================================================
async function initDataAndRender() {
    if (!IS_STATIC_HOST) {
        try {
            const resp = await fetch("/api/status");
            if (resp.ok) {
                await loadAppStatus();
                await loadRoutesGeoJSON();
                return;
            }
        } catch (e) {
            console.log("Switching to static + Firebase mode");
        }
    }

    // Static / GitHub Pages mode: load data/aubasa_routes.json + Firebase RTDB custom points & history
    const resp = await fetch("data/aubasa_routes.json");
    clientRoutesData = await resp.json();

    // Merge custom control points from Firebase RTDB
    try {
        const fbPtsResp = await fetch(`${FIREBASE_RTDB_URL}/custom_control_points.json`);
        if (fbPtsResp.ok) {
            const fbPts = await fbPtsResp.json();
            if (fbPts) {
                Object.values(fbPts).forEach(pt => {
                    const rcode = pt.route;
                    if (clientRoutesData[rcode]) {
                        let list = clientRoutesData[rcode].control_points.filter(
                            x => x.id !== pt.id && Math.abs(Number(x.km) - Number(pt.km)) > 0.05
                        );
                        list.push(pt);
                        list.sort((a, b) => Number(a.km) - Number(b.km));
                        clientRoutesData[rcode].control_points = list;
                    }
                });
            }
        }
    } catch (e) {
        console.warn("Firebase custom points fetch:", e);
    }

    clientCalibratedPolylines = buildClientCalibrator(clientRoutesData);
    renderRoutesOnMapFromObject(clientRoutesData);
    await refreshStaticStatusAndFirebaseHistory();
}

function renderRoutesOnMapFromObject(routesObj) {
    controlMarkersLayer.clearLayers();
    Object.values(routeLayers).forEach(l => map.removeLayer(l));
    routeLayers = {};

    Object.values(routesObj).forEach(route => {
        if (route.geometry && route.geometry.length > 1) {
            const poly = L.polyline(route.geometry, {
                color: route.color || "#0055A5",
                weight: 5,
                opacity: 0.85
            }).addTo(map);
            poly.bindTooltip(`${route.name} (${route.short_name})`, { sticky: true });
            routeLayers[route.code] = poly;
        }
        (route.control_points || []).forEach(cp => {
            const isVerified = cp.verified === true;
            const marker = L.circleMarker([cp.lat, cp.lon], {
                radius: isVerified ? 6 : 4,
                fillColor: isVerified ? "#FFB703" : route.color,
                color: "#061326",
                weight: 2,
                fillOpacity: 1
            });
            marker.bindPopup(
                `<strong>${route.name} · KM ${cp.km}</strong><br>${cp.name || ""}<br>` +
                `<span style="font-size:11px;color:#555">${isVerified ? "✓ Link GPS Verificado" : "Anclaje Cartográfico"}</span>`
            );
            controlMarkersLayer.addLayer(marker);
        });
    });
}

async function refreshStaticStatusAndFirebaseHistory() {
    const badge = document.getElementById("firebaseBadge");
    const badgeText = document.getElementById("firebaseBadgeText");
    badge.classList.add("connected");
    badgeText.textContent = "Conectado a Firebase Realtime DB";

    const statusContainer = document.getElementById("routesStatusList");
    const cpTableContainer = document.getElementById("activeControlPointsList");
    statusContainer.innerHTML = "";
    cpTableContainer.innerHTML = "";

    Object.values(clientRoutesData).forEach(r => {
        const cps = r.control_points || [];
        const verifiedCount = cps.filter(c => c.verified).length;
        const landmarksCount = (r.landmarks || []).length;
        const item = document.createElement("div");
        item.className = "route-status-item";
        const badgeClass = verifiedCount > 0 ? "verified" : "pending";
        const badgeLabel = verifiedCount > 0
            ? `${verifiedCount} links GPS verificados`
            : `${cps.length} puntos base (${landmarksCount} ref.)`;
        item.innerHTML = `
            <div class="rs-left">
                <span class="rs-color-dot" style="background:${r.color}"></span>
                <div>
                    <span class="rs-name">${r.name} (${r.short_name})</span>
                    <span class="rs-sub">${landmarksCount} referencias de planilla cargadas</span>
                </div>
            </div>
            <span class="rs-badge ${badgeClass}">${badgeLabel}</span>
        `;
        statusContainer.appendChild(item);

        cps.forEach(cp => {
            const row = document.createElement("div");
            row.className = "cp-row";
            row.innerHTML = `
                <div>
                    <strong>${r.short_name} · KM ${cp.km}</strong> — ${cp.name}
                    ${cp.verified ? '<span style="color:#6EE7B7;margin-left:6px;font-weight:600;">[Link GPS]</span>' : ''}
                </div>
                <div style="font-family:monospace;color:#94A3B8;">${Number(cp.lat).toFixed(4)}, ${Number(cp.lon).toFixed(4)}</div>
            `;
            cpTableContainer.appendChild(row);
        });
    });

    try {
        const hResp = await fetch(`${FIREBASE_RTDB_URL}/searches.json`);
        if (hResp.ok) {
            const hData = await hResp.json();
            const list = hData ? Object.values(hData).sort((a, b) => (b.ts_ms || 0) - (a.ts_ms || 0)) : [];
            renderHistory(list);
        }
    } catch (e) {
        renderHistory([]);
    }
}

async function loadRoutesGeoJSON() {
    try {
        const resp = await fetch("/api/routes-geojson");
        const data = await resp.json();
        if (!data.ok) return;
        renderRoutesOnMapFromObject(data.routes);
    } catch (err) {
        console.error("Error loading routes GeoJSON:", err);
    }
}

async function loadAppStatus() {
    try {
        const resp = await fetch("/api/status");
        const data = await resp.json();
        if (!data.ok) return;

        const badge = document.getElementById("firebaseBadge");
        const badgeText = document.getElementById("firebaseBadgeText");
        badgeText.textContent = data.db_status.mode;
        if (data.db_status.firebase_connected) {
            badge.classList.add("connected");
        }

        const statusContainer = document.getElementById("routesStatusList");
        statusContainer.innerHTML = "";
        const cpTableContainer = document.getElementById("activeControlPointsList");
        cpTableContainer.innerHTML = "";

        data.routes.forEach(r => {
            const item = document.createElement("div");
            item.className = "route-status-item";
            const badgeClass = r.verified_points_count > 0 ? "verified" : "pending";
            const badgeLabel = r.verified_points_count > 0
                ? `${r.verified_points_count} links GPS verificados`
                : `${r.control_points_count} puntos base (${r.landmarks_count} ref.)`;

            item.innerHTML = `
                <div class="rs-left">
                    <span class="rs-color-dot" style="background:${r.color}"></span>
                    <div>
                        <span class="rs-name">${r.name} (${r.short_name})</span>
                        <span class="rs-sub">${r.landmarks_count} referencias de planilla cargadas</span>
                    </div>
                </div>
                <span class="rs-badge ${badgeClass}">${badgeLabel}</span>
            `;
            statusContainer.appendChild(item);

            (r.control_points || []).forEach(cp => {
                const row = document.createElement("div");
                row.className = "cp-row";
                row.innerHTML = `
                    <div>
                        <strong>${r.short_name} · KM ${cp.km}</strong> — ${cp.name}
                        ${cp.verified ? '<span style="color:#6EE7B7;margin-left:6px;font-weight:600;">[Link GPS]</span>' : ''}
                    </div>
                    <div style="font-family:monospace;color:#94A3B8;">${Number(cp.lat).toFixed(4)}, ${Number(cp.lon).toFixed(4)}</div>
                `;
                cpTableContainer.appendChild(row);
            });
        });

        renderHistory(data.history || []);
    } catch (err) {
        console.error("Error loading status:", err);
    }
}

function renderHistory(historyItems) {
    const container = document.getElementById("historyList");
    if (!historyItems.length) {
        container.innerHTML = `<div style="color:#94A3B8;font-size:0.85rem;padding:12px 0;">Aún no hay búsquedas registradas.</div>`;
        return;
    }
    container.innerHTML = "";
    historyItems.slice(0, 6).forEach(h => {
        const row = document.createElement("div");
        row.className = "history-item";
        row.innerHTML = `
            <div>
                <strong style="color:#fff;font-size:0.9rem;">${h.route_name} · ${h.km_formatted}</strong>
                <div style="color:#94A3B8;font-size:0.76rem;">${h.nearest_landmark || h.sentido_estimado}</div>
            </div>
            <span style="color:#7DD3FC;font-size:0.78rem;font-weight:600;">Ver ↗</span>
        `;
        row.addEventListener("click", () => {
            const q = h.query || `${h.lat}, ${h.lon}`;
            document.getElementById("mapsInput").value = q;
            runLocateQuery(q);
        });
        container.appendChild(row);
    });
}

function bindEvents() {
    const form = document.getElementById("locateForm");
    const input = document.getElementById("mapsInput");
    const pasteBtn = document.getElementById("pasteBtn");
    const clearBtn = document.getElementById("clearBtn");

    input.addEventListener("input", () => {
        clearBtn.classList.toggle("hidden", !input.value.trim());
    });

    pasteBtn.addEventListener("click", async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                input.value = text.trim();
                clearBtn.classList.remove("hidden");
                runLocateQuery(input.value);
            }
        } catch {
            input.focus();
        }
    });

    clearBtn.addEventListener("click", () => {
        input.value = "";
        clearBtn.classList.add("hidden");
        document.getElementById("errorAlert").classList.add("hidden");
        input.focus();
    });

    form.addEventListener("submit", (e) => {
        e.preventDefault();
        runLocateQuery(input.value);
    });

    document.getElementById("copyReportBtn").addEventListener("click", () => {
        if (!lastLocateResult) return;
        const r = lastLocateResult;
        const topRef = r.nearest_landmarks && r.nearest_landmarks[0]
            ? `${r.nearest_landmarks[0].detalle} (KM ${r.nearest_landmarks[0].km_label} - ${r.nearest_landmarks[0].rel_pos})`
            : "Sin referencia cercana";
        const report = [
            `🚨 ASISTENCIA VIAL AUBASA`,
            `• Ruta: ${r.route_name} (${r.route_short})`,
            `• Kilómetro: ${r.km_formatted} (Progresiva ${r.km_progressive})`,
            `• Sentido: ${r.sentido_estimado}`,
            `• Referencia: ${topRef}`,
            `• Coordenadas: ${r.input_lat}, ${r.input_lon}`,
            `• Maps: https://www.google.com/maps?q=${r.input_lat},${r.input_lon}`
        ].join("\n");

        navigator.clipboard.writeText(report);
        const label = document.getElementById("copyReportText");
        label.textContent = "¡Parte Copiado!";
        setTimeout(() => { label.textContent = "Copiar Parte Vial"; }, 2200);
    });

    document.getElementById("resetMapZoomBtn").addEventListener("click", () => {
        map.setView([-36.35, -57.55], 7);
    });

    const modal = document.getElementById("calibrateModal");
    const openBtns = [
        document.getElementById("openCalibrateModalBtn"),
        document.getElementById("openCalibrateModalBtn2")
    ];
    openBtns.forEach(b => b && b.addEventListener("click", () => {
        document.getElementById("calFeedback").classList.add("hidden");
        modal.classList.remove("hidden");
    }));

    document.getElementById("useForCalibrationBtn").addEventListener("click", () => {
        if (lastLocateResult) {
            document.getElementById("calRoute").value = lastLocateResult.route_code;
            document.getElementById("calKm").value = lastLocateResult.km_exact;
            document.getElementById("calLink").value = lastLocateResult.input_query || `${lastLocateResult.input_lat}, ${lastLocateResult.input_lon}`;
        }
        document.getElementById("calFeedback").classList.add("hidden");
        modal.classList.remove("hidden");
    });

    const closeModal = () => modal.classList.add("hidden");
    document.getElementById("closeCalibrateModalBtn").addEventListener("click", closeModal);
    document.getElementById("cancelCalModalBtn").addEventListener("click", closeModal);

    document.getElementById("calibrateForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const fb = document.getElementById("calFeedback");
        fb.classList.add("hidden");

        const payload = {
            route: document.getElementById("calRoute").value,
            km: document.getElementById("calKm").value,
            name: document.getElementById("calName").value,
            link: document.getElementById("calLink").value
        };

        try {
            if (!IS_STATIC_HOST) {
                const resp = await fetch("/api/calibrate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                const data = await resp.json();
                fb.classList.remove("hidden", "success", "error");
                if (!data.ok) {
                    fb.classList.add("error");
                    fb.textContent = data.error || "Error al guardar calibración.";
                    return;
                }
                fb.classList.add("success");
                fb.textContent = `✓ ${data.message}`;
                await loadAppStatus();
                await loadRoutesGeoJSON();
            } else {
                const { lat, lon, resolvedUrl } = await parseGoogleMapsClient(payload.link);
                const kmVal = parseFloat(String(payload.km).replace(",", "."));
                const safeId = `custom-${payload.route.toLowerCase()}-km${String(kmVal).replace(".", "_")}-${Date.now().toString(36)}`;
                const ptObj = {
                    id: safeId,
                    route: payload.route,
                    km: kmVal,
                    lat: Number(lat.toFixed(6)),
                    lon: Number(lon.toFixed(6)),
                    name: payload.name,
                    link: payload.link,
                    resolved_url: resolvedUrl,
                    verified: true,
                    custom: true
                };
                await fetch(`${FIREBASE_RTDB_URL}/custom_control_points/${safeId}.json`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(ptObj)
                });
                fb.classList.remove("hidden", "success", "error");
                fb.classList.add("success");
                fb.textContent = `✓ Punto guardado en Firebase (${payload.route} KM ${kmVal})`;
                await initDataAndRender();
            }
            document.getElementById("calKm").value = "";
            document.getElementById("calName").value = "";
            document.getElementById("calLink").value = "";
        } catch (err) {
            fb.classList.remove("hidden");
            fb.classList.add("error");
            fb.textContent = err.message || "Error de conexión al guardar.";
        }
    });
}

async function runLocateQuery(query) {
    if (!query || !query.trim()) return;
    const errorAlert = document.getElementById("errorAlert");
    const errorText = document.getElementById("errorText");
    const submitBtn = document.getElementById("submitBtn");
    errorAlert.classList.add("hidden");
    submitBtn.disabled = true;

    try {
        if (!IS_STATIC_HOST) {
            const resp = await fetch("/api/locate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: query.trim() })
            });
            const data = await resp.json();
            if (!data.ok) {
                errorText.textContent = data.error || "No se pudo determinar la ubicación.";
                errorAlert.classList.remove("hidden");
                return;
            }
            renderLocateResult(data.result);
            loadAppStatus();
        } else {
            const { lat, lon, resolvedUrl } = await parseGoogleMapsClient(query.trim());
            const result = locateClient(lat, lon);
            result.input_query = query.trim();
            result.resolved_url = resolvedUrl;
            renderLocateResult(result);

            // Log search to Firebase RTDB
            await fetch(`${FIREBASE_RTDB_URL}/searches.json`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    query: query.trim(),
                    route_code: result.route_code,
                    route_name: result.route_name,
                    km_exact: result.km_exact,
                    km_formatted: result.km_formatted,
                    sentido_estimado: result.sentido_estimado,
                    nearest_landmark: result.nearest_landmarks[0]?.detalle || "",
                    lat: result.input_lat,
                    lon: result.input_lon,
                    timestamp: new Date().toISOString(),
                    ts_ms: Date.now()
                })
            });
            await refreshStaticStatusAndFirebaseHistory();
        }
    } catch (err) {
        errorText.textContent = err.message || "Error de comunicación.";
        errorAlert.classList.remove("hidden");
    } finally {
        submitBtn.disabled = false;
    }
}

function renderLocateResult(r) {
    lastLocateResult = r;
    document.getElementById("emptyStateCard").classList.add("hidden");
    const card = document.getElementById("resultCard");
    card.classList.remove("hidden");

    const warnEl = document.getElementById("offRouteWarning");
    if (r.off_route_warning) {
        warnEl.textContent = r.off_route_warning;
        warnEl.classList.remove("hidden");
    } else {
        warnEl.classList.add("hidden");
    }

    document.getElementById("resRouteShort").textContent = r.route_short;
    document.getElementById("resRouteName").textContent = r.route_name;
    document.getElementById("resKmFormatted").textContent = r.km_formatted;
    document.getElementById("resKmProgressive").textContent = `Progresiva ${r.km_progressive}`;
    document.getElementById("resSentido").textContent = r.sentido_estimado;

    if (r.distance_to_route_m <= 35) {
        document.getElementById("resDistRoute").textContent = `Sobre calzada (${r.distance_to_route_m} m del eje)`;
    } else if (r.distance_to_route_m < 1000) {
        document.getElementById("resDistRoute").textContent = `A ${r.distance_to_route_m} metros de la traza`;
    } else {
        document.getElementById("resDistRoute").textContent = `A ${r.distance_to_route_km} km de la traza`;
    }

    document.getElementById("resCoords").textContent = `${r.input_lat}, ${r.input_lon}`;

    if (r.prev_control_point && r.next_control_point) {
        document.getElementById("resCalibrationSpan").textContent =
            `KM ${r.prev_control_point.km} → KM ${r.next_control_point.km}`;
    }

    const lmContainer = document.getElementById("landmarksList");
    lmContainer.innerHTML = "";
    (r.nearest_landmarks || []).forEach((lm, idx) => {
        const row = document.createElement("div");
        row.className = `landmark-row ${idx === 0 ? "primary-match" : ""}`;
        row.innerHTML = `
            <div class="lm-left">
                <span class="lm-km-badge">KM ${lm.km_label}</span>
                <div>
                    <div class="lm-title">${lm.detalle}</div>
                    <span class="lm-sentido">Sentido ref: ${lm.sentido}</span>
                </div>
            </div>
            <div class="lm-dist-pill">${lm.rel_pos}</div>
        `;
        lmContainer.appendChild(row);
    });

    document.getElementById("openGmapsBtn").href = `https://www.google.com/maps?q=${r.input_lat},${r.input_lon}`;

    if (userPinMarker) map.removeLayer(userPinMarker);
    if (snappedPinMarker) map.removeLayer(snappedPinMarker);
    if (snapLine) map.removeLayer(snapLine);

    userPinMarker = L.marker([r.input_lat, r.input_lon]).addTo(map);
    userPinMarker.bindPopup(
        `<div style="font-family:Inter,sans-serif;">` +
        `<strong style="color:#0055A5;font-size:14px;">${r.route_name} · ${r.km_formatted}</strong><br>` +
        `<span>Progresiva: <b>${r.km_progressive}</b></span><br>` +
        `<span>Sentido: ${r.sentido_estimado}</span><br>` +
        (r.nearest_landmarks && r.nearest_landmarks[0]
            ? `<span style="color:#475569;font-size:12px;">Ref: ${r.nearest_landmarks[0].detalle} (KM ${r.nearest_landmarks[0].km_label})</span>`
            : "") +
        `</div>`
    ).openPopup();

    snappedPinMarker = L.circleMarker([r.snapped_lat, r.snapped_lon], {
        radius: 7,
        fillColor: "#10B981",
        color: "#FFFFFF",
        weight: 2,
        fillOpacity: 1
    }).addTo(map);

    snapLine = L.polyline([[r.input_lat, r.input_lon], [r.snapped_lat, r.snapped_lon]], {
        color: "#FFB703",
        weight: 2,
        dashArray: "5, 5"
    }).addTo(map);

    map.flyTo([r.snapped_lat, r.snapped_lon], 13, {
        duration: 1.1
    });
}
