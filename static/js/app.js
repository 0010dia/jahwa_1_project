const DEFAULT_CENTER = { lat: 36.1195, lng: 128.3446 };
const FALLBACK_BOUNDS = {
  minLat: 36.055,
  maxLat: 36.265,
  minLng: 128.255,
  maxLng: 128.475,
};

const state = {
  config: null,
  map: null,
  usingTmap: false,
  shelters: [],
  floodZones: [],
  floodSummary: [],
  liveFloodZones: [],
  liveFloodSummary: [],
  liveFloodSignature: "",
  liveFloodPolling: false,
  selectedShelterId: null,
  currentLocation: null,
  currentLocationSource: null,
  currentRoute: null,
  tmapLayers: [],
  mapError: null,
};

const $ = (selector) => document.querySelector(selector);

function formatDistance(meters) {
  if (meters === null || meters === undefined) return "-";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

function formatTime(seconds) {
  if (!seconds) return "-";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const remain = minutes % 60;
  return remain ? `${hours}시간 ${remain}분` : `${hours}시간`;
}

const STATUS_LABELS = {
  neutral: "경로 안내",
  loading: "확인 중",
  safe: "침수 교차 없음",
  detour: "침수 우회 완료",
  attention: "확인 필요",
  warning: "침수 주의",
  danger: "경로 위험",
  reported: "신고 완료",
};

function setStatus(message, detail = "", tone = "neutral") {
  const status = $("#mapStatus");
  const label = document.createElement("span");
  label.className = "map-status-label";
  label.textContent = STATUS_LABELS[tone] || STATUS_LABELS.neutral;
  const primary = document.createElement("strong");
  primary.textContent = message;
  const copy = document.createElement("div");
  copy.className = "map-status-copy";
  copy.append(label, primary);
  status.className = `map-status tone-${tone}`;
  status.replaceChildren(copy);
  if (detail) {
    const secondary = document.createElement("span");
    secondary.textContent = detail;
    copy.appendChild(secondary);
  }
}

function loadTmap(appKey) {
  return new Promise((resolve, reject) => {
    if (!appKey) {
      reject(new Error("TMAP_APP_KEY가 설정되지 않았습니다."));
      return;
    }

    const startedAt = Date.now();
    const checkReady = () => {
      if (window.Tmapv2 && typeof window.Tmapv2.Map === "function") {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= 10000) {
        reject(new Error("TMAP 지도 SDK 준비 시간이 초과되었습니다."));
        return;
      }
      window.setTimeout(checkReady, 100);
    };

    checkReady();
  });
}

async function initialize() {
  setStatus("위치를 확인하면 가까운 대피소를 계산합니다.");
  const searchParams = new URLSearchParams(window.location.search);
  $("#includeRiskAreas").checked = searchParams.get("riskAreas") === "1";
  $("#includeFiftyYear").checked = searchParams.get("fiftyYear") === "1";
  const [configResponse, floodResponse] = await Promise.all([
    fetch("/api/config"),
    fetch("/api/flood-zones"),
  ]);
  state.config = await configResponse.json();
  const floodPayload = await floodResponse.json();
  state.floodZones = floodPayload.features || [];
  state.floodSummary = floodPayload.summary || [];

  let liveFloodError = null;
  try {
    await refreshLiveFloodZones();
  } catch (error) {
    liveFloodError = error;
  }

  await initializeMap();
  bindEvents();
  renderFloodList();
  await refreshShelters();
  drawAll();
  if (liveFloodError) {
    setStatus(
      "현재 침수구역을 불러오지 못했습니다.",
      liveFloodError instanceof Error ? liveFloodError.message : "잠시 후 다시 시도해 주세요.",
      "attention"
    );
  }
  window.setInterval(pollLiveFloodZones, 15000);
}

async function initializeMap() {
  const badge = $("#apiBadge");
  try {
    await loadTmap(state.config.tmapAppKey);
    state.map = new Tmapv2.Map("map", {
      center: new Tmapv2.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng),
      width: "100%",
      height: "100%",
      zoom: 13,
      httpsMode: true,
    });
    state.usingTmap = true;
    state.mapError = null;
    badge.textContent = "TMAP";
    badge.classList.remove("warning");
    $("#map").hidden = false;
    $("#fallbackMap").hidden = true;
  } catch (error) {
    console.error("TMAP 지도 초기화 실패", error);
    state.usingTmap = false;
    state.mapError = error instanceof Error ? error.message : "알 수 없는 오류";
    badge.textContent = "지도 연결 실패";
    badge.classList.add("warning");
    $("#map").hidden = true;
    $("#fallbackMap").hidden = false;
    renderFallbackBase();
  }
}

function bindEvents() {
  $("#locateBtn").addEventListener("click", locateUser);
  $("#demoBtn").addEventListener("click", () => {
    setCurrentLocation(
      { lat: 36.1289, lng: 128.3309 },
      "구미역 기준 위치를 적용했습니다.",
      "demo"
    );
  });
  $("#reportBtn").addEventListener("click", openReportDialog);
  $("#closeReportDialog").addEventListener("click", closeReportDialog);
  $("#cancelReportBtn").addEventListener("click", closeReportDialog);
  $("#submitReportBtn").addEventListener("click", submitLocationReport);
  $("#reportDialog").addEventListener("click", (event) => {
    if (event.target === $("#reportDialog")) closeReportDialog();
  });
  $("#modeSelect").addEventListener("change", requestSelectedRoute);
  $("#avoidFlood").addEventListener("change", requestSelectedRoute);
  $("#includeRiskAreas").addEventListener("change", updateFloodLayerSelection);
  $("#includeFiftyYear").addEventListener("change", updateFloodLayerSelection);
}

async function updateFloodLayerSelection() {
  renderFloodList();
  await refreshShelters();
  await requestSelectedRoute();
  drawAll();
}

async function refreshLiveFloodZones() {
  const response = await fetch("/api/live-flood-zones");
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "실시간 침수구역을 불러오지 못했습니다.");
  const features = payload.features || [];
  const signature = features
    .map((feature) => `${feature.properties?.id}:${feature.properties?.approvedAt || ""}`)
    .sort()
    .join("|");
  const changed = signature !== state.liveFloodSignature;
  state.liveFloodZones = features;
  state.liveFloodSummary = payload.summary || [];
  state.liveFloodSignature = signature;
  return changed;
}

async function pollLiveFloodZones() {
  if (state.liveFloodPolling) return;
  state.liveFloodPolling = true;
  try {
    const changed = await refreshLiveFloodZones();
    if (changed) await updateFloodLayerSelection();
  } catch (error) {
    console.error("실시간 침수구역 갱신 실패", error);
  } finally {
    state.liveFloodPolling = false;
  }
}

function locateUser() {
  if (!navigator.geolocation) {
    setStatus("이 브라우저에서는 위치 확인을 사용할 수 없습니다.", "", "attention");
    return;
  }

  state.currentLocationSource = null;
  $("#reportBtn").disabled = true;
  setStatus("현재 위치를 확인하는 중입니다.", "", "loading");
  navigator.geolocation.getCurrentPosition(
    (position) => {
      setCurrentLocation(
        {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        },
        "현재 위치를 기준으로 가까운 대피소를 계산했습니다.",
        "gps"
      );
    },
    () => {
      setStatus(
        "위치 권한을 확인하지 못했습니다.",
        "구미역 기준 버튼으로 위치를 지정할 수 있습니다.",
        "attention"
      );
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
  );
}

async function setCurrentLocation(location, message, source = "unknown") {
  state.currentLocation = location;
  state.currentLocationSource = source;
  $("#reportBtn").disabled = source !== "gps";
  $("#locationText").textContent = `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`;
  setStatus(message);
  await refreshShelters();
  if (state.shelters.length) {
    await selectShelter(state.shelters[0].id);
  }
  drawAll();
}

function openReportDialog() {
  if (!state.currentLocation || state.currentLocationSource !== "gps") {
    setStatus(
      "실제 현재 위치를 먼저 확인해 주세요.",
      "구미역 기준 위치는 신고할 수 없습니다.",
      "attention"
    );
    return;
  }

  const location = state.currentLocation;
  $("#reportCoordinates").textContent = `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`;
  $("#reportAccuracy").textContent = Number.isFinite(location.accuracy)
    ? `GPS 정확도 약 ${Math.round(location.accuracy)} m`
    : "GPS 정확도 정보 없음";
  $("#reportNote").value = "";
  $("#reportDialog").showModal();
}

function closeReportDialog() {
  const dialog = $("#reportDialog");
  if (dialog.open) dialog.close();
}

async function submitLocationReport() {
  if (!state.currentLocation || state.currentLocationSource !== "gps") {
    closeReportDialog();
    setStatus("실제 현재 위치를 다시 확인해 주세요.", "", "attention");
    return;
  }

  const submitButton = $("#submitReportBtn");
  submitButton.disabled = true;
  submitButton.textContent = "전송 중";
  try {
    const response = await fetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lat: state.currentLocation.lat,
        lng: state.currentLocation.lng,
        accuracyM: Number.isFinite(state.currentLocation.accuracy)
          ? state.currentLocation.accuracy
          : null,
        note: $("#reportNote").value.trim(),
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "신고를 저장하지 못했습니다.");
    }
    closeReportDialog();
    setStatus(
      "현재 위치 신고가 서버에 저장되었습니다.",
      `신고 번호 ${payload.report.id} · 관리 화면에서 확인할 수 있습니다.`,
      "reported"
    );
  } catch (error) {
    setStatus(
      "현재 위치 신고를 저장하지 못했습니다.",
      error instanceof Error ? error.message : "잠시 후 다시 시도해 주세요.",
      "danger"
    );
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "신고 전송";
  }
}

async function refreshShelters() {
  const params = new URLSearchParams();
  if (state.currentLocation) {
    params.set("lat", state.currentLocation.lat);
    params.set("lng", state.currentLocation.lng);
  }
  params.set("includeRiskAreas", $("#includeRiskAreas").checked ? "true" : "false");
  params.set("includeFiftyYear", $("#includeFiftyYear").checked ? "true" : "false");
  const query = params.size ? `?${params.toString()}` : "";
  const response = await fetch(`/api/shelters${query}`);
  const payload = await response.json();
  state.shelters = payload.shelters || [];
  if (!state.selectedShelterId && payload.nearest) {
    state.selectedShelterId = payload.nearest.id;
  }
  renderShelters(payload.nearest);
}

function renderShelters(nearest) {
  $("#shelterCount").textContent = `${state.shelters.length}곳`;
  const nearestCard = $("#nearestCard");
  nearestCard.className = nearest ? "nearest-card" : "empty-state";
  nearestCard.replaceChildren();

  if (nearest) {
    nearestCard.appendChild(buildShelterSummary(nearest));
    $("#nearestDistance").textContent = formatDistance(nearest.distanceM);
  } else {
    nearestCard.textContent = "좌표가 들어오면 자동으로 추천합니다.";
    $("#nearestDistance").textContent = "-";
  }

  const list = $("#shelterList");
  list.replaceChildren();
  state.shelters.forEach((shelter) => {
    const card = document.createElement("article");
    card.className = `shelter-card${shelter.id === state.selectedShelterId ? " active" : ""}`;

    const body = buildShelterSummary(shelter);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "경로";
    button.addEventListener("click", () => selectShelter(shelter.id));

    card.append(body, button);
    list.appendChild(card);
  });
}

function buildShelterSummary(shelter) {
  const wrap = document.createElement("div");
  const name = document.createElement("div");
  name.className = "shelter-name";
  name.textContent = shelter.name;

  const address = document.createElement("div");
  address.className = "address";
  address.textContent = shelter.address;

  const badges = document.createElement("div");
  badges.className = "badge-row";
  badges.appendChild(makeBadge(formatDistance(shelter.distanceM), "safe"));
  badges.appendChild(makeBadge(`${shelter.capacity || "-"}명`, "safe"));
  if (shelter.riskZones && shelter.riskZones.length) {
    badges.appendChild(makeBadge("우회 권장", "warn"));
  } else if (shelter.distanceM !== null && shelter.distanceM !== undefined) {
    badges.appendChild(makeBadge("직접 경로 양호", "safe"));
  }
  if (shelter.verified === false) {
    badges.appendChild(makeBadge("샘플", "danger"));
  }

  wrap.append(name, address, badges);
  return wrap;
}

function makeBadge(text, tone) {
  const badge = document.createElement("span");
  badge.className = `badge ${tone || ""}`;
  badge.textContent = text;
  return badge;
}

async function selectShelter(id) {
  state.selectedShelterId = id;
  renderShelters(state.shelters.find((shelter) => shelter.id === id));
  await requestSelectedRoute();
  drawAll();
}

async function requestSelectedRoute() {
  if (!state.currentLocation || !state.selectedShelterId) {
    drawAll();
    return;
  }

  const selected = state.shelters.find((shelter) => shelter.id === state.selectedShelterId);
  setStatus(`${selected.name}까지 경로를 계산하는 중입니다.`, "", "loading");

  const response = await fetch("/api/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      start: state.currentLocation,
      shelterId: state.selectedShelterId,
      mode: $("#modeSelect").value,
      avoidFlood: $("#avoidFlood").checked,
      includeRiskAreas: $("#includeRiskAreas").checked,
      includeFiftyYear: $("#includeFiftyYear").checked,
    }),
  });
  state.currentRoute = await response.json();
  renderRouteSummary();
  drawAll();

  if (!response.ok || state.currentRoute.error) {
    setStatus(
      "경로를 계산하지 못했습니다.",
      state.currentRoute.error || "잠시 후 다시 시도해 주세요.",
      "danger"
    );
    return;
  }

  const remainingCount = state.currentRoute.riskZones?.length || 0;
  const avoidedCount = state.currentRoute.avoidedRiskZones?.length || 0;
  let riskText = " 실제 경로에서 침수 위험지역 교차가 없습니다.";
  let statusTone = "safe";
  if (!state.currentRoute.avoidFlood && remainingCount) {
    riskText = ` 침수 우회가 꺼져 있어 위험지역 ${remainingCount}곳을 통과합니다.`;
    statusTone = "danger";
  } else if (state.currentRoute.avoidanceStatus === "partial") {
    statusTone = "warning";
    if (state.currentRoute.riskReductionPercent > 0) {
      riskText = ` 완전 우회가 불가능해 침수 영향 구간을 ${state.currentRoute.riskReductionPercent}% 줄인 경로입니다.`;
    } else {
      riskText = ` 주의: 재탐색 후에도 위험지역 ${remainingCount}곳이 경로에 남아 있습니다.`;
    }
  } else if (state.currentRoute.avoidanceStatus === "unavoidable") {
    statusTone = "danger";
    if (state.currentRoute.accessLimitedRiskZones?.length) {
      riskText = " 대피소 진입도로가 침수 위험구역에 포함되어 완전 우회할 수 없습니다.";
    } else {
      riskText = ` 출발지 또는 목적지가 포함된 위험지역 ${remainingCount}곳은 완전히 피할 수 없습니다.`;
    }
  } else if (avoidedCount) {
    riskText = ` 실제 경로를 재검사해 침수 위험지역 ${avoidedCount}곳을 우회했습니다.`;
    statusTone = "detour";
  }
  if (state.currentRoute.warning && statusTone === "safe") {
    statusTone = "warning";
  }
  setStatus(
    `${selected.name}까지 ${formatDistance(state.currentRoute.summary?.totalDistance)} 경로입니다.${riskText}`,
    state.currentRoute.warning || "",
    statusTone
  );
}

function renderRouteSummary() {
  const route = state.currentRoute;
  $("#routeSource").textContent = route?.source === "tmap" ? "TMAP" : "로컬";
  $("#routeDistance").textContent = formatDistance(route?.summary?.totalDistance);
  $("#routeTime").textContent = formatTime(route?.summary?.totalTime);

  const steps = $("#routeSteps");
  steps.replaceChildren();
  (route?.steps || []).forEach((step) => {
    const item = document.createElement("li");
    item.textContent = step.distance ? `${step.description} · ${formatDistance(step.distance)}` : step.description;
    steps.appendChild(item);
  });
}

function renderFloodList() {
  const summaries = [...state.floodSummary, ...state.liveFloodSummary]
    .filter(isFloodLayerEnabled);
  $("#floodCount").textContent = `${summaries.length}개 항목`;
  const list = $("#floodList");
  list.replaceChildren();
  summaries.forEach((zone) => {
    const item = document.createElement("div");
    item.className = "flood-item";
    item.style.borderLeftColor = zone.color || "#c2413a";
    const name = document.createElement("strong");
    name.textContent = zone.name;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${zone.riskLevel} · ${zone.note}`;
    item.append(name, meta);
    list.appendChild(item);
  });
}

function isFloodLayerEnabled(item) {
  const datasetType = item?.properties?.datasetType || item?.datasetType;
  if (datasetType === "live") return true;
  if (datasetType === "history") return $("#includeRiskAreas").checked;
  if (datasetType === "scenario") return $("#includeFiftyYear").checked;
  return false;
}

function visibleFloodFeatures() {
  return [...state.floodZones, ...state.liveFloodZones].filter(isFloodLayerEnabled);
}

function geometryPolygons(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

function clearTmapLayers() {
  state.tmapLayers.forEach((layer) => {
    if (layer && typeof layer.setMap === "function") {
      layer.setMap(null);
    }
  });
  state.tmapLayers = [];
}

function drawAll() {
  if (state.usingTmap) {
    drawTmap();
  } else {
    drawFallback();
  }
}

function drawTmap() {
  if (!state.map || !window.Tmapv2) return;
  clearTmapLayers();

  visibleFloodFeatures().forEach((feature) => {
    const color = feature.properties?.color || "#c2413a";
    const isLiveFlood = feature.properties?.datasetType === "live";
    geometryPolygons(feature.geometry).forEach((polygon) => {
      const exterior = polygon[0] || [];
      if (exterior.length < 3) return;
      const path = exterior.map(([lng, lat]) => new Tmapv2.LatLng(lat, lng));
      state.tmapLayers.push(new Tmapv2.Polygon({
        paths: path,
        map: state.map,
        fillColor: color,
        fillOpacity: isLiveFlood ? 0.45 : 0.2,
        strokeColor: color,
        strokeWeight: isLiveFlood ? 3 : 1,
      }));
    });
  });

  state.shelters.forEach((shelter) => {
    state.tmapLayers.push(new Tmapv2.Marker({
      position: new Tmapv2.LatLng(shelter.lat, shelter.lng),
      map: state.map,
      title: shelter.name,
    }));
  });

  if (state.currentLocation) {
    state.tmapLayers.push(new Tmapv2.Marker({
      position: new Tmapv2.LatLng(state.currentLocation.lat, state.currentLocation.lng),
      map: state.map,
      title: "현재 위치",
    }));
  }

  if (state.currentRoute?.path?.length) {
    const routeHasRisk = Boolean(state.currentRoute.riskZones?.length);
    const segments = state.currentRoute.pathSegments?.length
      ? state.currentRoute.pathSegments
      : [state.currentRoute.path];
    const boundsPath = [];
    segments.forEach((segment) => {
      const path = segment.map((point) => new Tmapv2.LatLng(point.lat, point.lng));
      boundsPath.push(...path);
      state.tmapLayers.push(new Tmapv2.Polyline({
        path,
        map: state.map,
        strokeColor: routeHasRisk ? "#b45309" : "#0f766e",
        strokeWeight: 6,
        strokeOpacity: 0.9,
      }));
    });
    fitTmap(boundsPath);
  } else if (state.currentLocation) {
    state.map.setCenter(new Tmapv2.LatLng(state.currentLocation.lat, state.currentLocation.lng));
    state.map.setZoom(14);
  }
}

function fitTmap(path) {
  try {
    const bounds = new Tmapv2.LatLngBounds();
    path.forEach((point) => bounds.extend(point));
    state.map.fitBounds(bounds);
  } catch {
    const middle = path[Math.floor(path.length / 2)];
    state.map.setCenter(middle);
  }
}

function renderFallbackBase() {
  const container = $("#fallbackMap");
  container.replaceChildren();
  const label = document.createElement("div");
  label.className = "fallback-label";
  label.textContent = state.mapError
    ? `TMAP 지도를 불러오지 못했습니다: ${state.mapError}`
    : "TMAP 지도에 연결하는 중입니다.";
  container.appendChild(label);
}

function drawFallback() {
  renderFallbackBase();
  const container = $("#fallbackMap");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("fallback-shape");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");

  visibleFloodFeatures().forEach((feature) => {
    const color = feature.properties?.color || "#c2413a";
    const isLiveFlood = feature.properties?.datasetType === "live";
    geometryPolygons(feature.geometry).forEach((rings) => {
      const exterior = rings[0] || [];
      if (exterior.length < 3) return;
      const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      polygon.setAttribute("points", exterior.map(([lng, lat]) => {
        const projected = project({ lat, lng });
        return `${projected.x},${projected.y}`;
      }).join(" "));
      polygon.setAttribute("fill", color);
      polygon.setAttribute("fill-opacity", isLiveFlood ? "0.45" : "0.2");
      polygon.setAttribute("stroke", color);
      polygon.setAttribute("stroke-width", isLiveFlood ? "0.5" : "0.25");
      svg.appendChild(polygon);
    });
  });

  if (state.currentRoute?.path?.length) {
    const segments = state.currentRoute.pathSegments?.length
      ? state.currentRoute.pathSegments
      : [state.currentRoute.path];
    segments.forEach((segment) => {
      const routeLine = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      routeLine.setAttribute("points", segment.map((point) => {
        const projected = project(point);
        return `${projected.x},${projected.y}`;
      }).join(" "));
      routeLine.setAttribute("fill", "none");
      routeLine.setAttribute("stroke", state.currentRoute.riskZones?.length ? "#b45309" : "#0f766e");
      routeLine.setAttribute("stroke-width", "0.75");
      routeLine.setAttribute("stroke-linecap", "round");
      routeLine.setAttribute("stroke-linejoin", "round");
      svg.appendChild(routeLine);
    });
  }

  container.appendChild(svg);

  state.shelters.forEach((shelter) => {
    addFallbackMarker(shelter, shelter.id === state.selectedShelterId ? "selected" : "");
  });
  if (state.currentLocation) {
    addFallbackMarker(state.currentLocation, "current");
  }
}

function addFallbackMarker(point, variant) {
  const marker = document.createElement("div");
  marker.className = `fallback-marker ${variant}`;
  const projected = project(point);
  marker.style.left = `${projected.x}%`;
  marker.style.top = `${projected.y}%`;
  $("#fallbackMap").appendChild(marker);
}

function project(point) {
  const x = ((point.lng - FALLBACK_BOUNDS.minLng) / (FALLBACK_BOUNDS.maxLng - FALLBACK_BOUNDS.minLng)) * 100;
  const y = ((FALLBACK_BOUNDS.maxLat - point.lat) / (FALLBACK_BOUNDS.maxLat - FALLBACK_BOUNDS.minLat)) * 100;
  return {
    x: Math.max(2, Math.min(98, x)),
    y: Math.max(2, Math.min(98, y)),
  };
}

initialize().catch((error) => {
  console.error(error);
  setStatus("앱을 초기화하지 못했습니다.", "서버 로그를 확인하세요.", "danger");
});
