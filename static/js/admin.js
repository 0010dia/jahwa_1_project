const DEFAULT_CENTER = { lat: 36.1195, lng: 128.3446 };

const state = {
  map: null,
  reports: [],
  markers: [],
  dongStatistics: null,
  historyStatistics: null,
  dongPolygons: [],
  selectedReportId: null,
  selectedDongCode: null,
  reportFilter: "all",
  panelView: "reports",
  placementMode: false,
  pendingPoint: null,
  pendingMarker: null,
};

const $ = (selector) => document.querySelector(selector);
const STATUS_LABELS = {
  pending: "승인 대기",
  active: "현재 침수",
  resolved: "침수 해제",
};

function loadTmap() {
  return new Promise((resolve, reject) => {
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

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "-";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function reportLabel(report, detailed = false) {
  if (report.isSample) return `${detailed ? "데모 침수" : "데모"} #${report.id}`;
  if (report.isAdminCreated) {
    return `${detailed ? "관리자 등록 침수" : "관리자"} #${report.id}`;
  }
  return `신고 #${report.id}`;
}

async function initialize() {
  $("#refreshReports").addEventListener("click", loadReports);
  $("#openHistoryStatistics").addEventListener("click", openHistoryStatistics);
  $("#reportsTab").addEventListener("click", () => setPanelView("reports"));
  $("#dongStatsTab").addEventListener("click", () => setPanelView("dongs"));
  $("#startFloodPlacement").addEventListener("click", () => {
    setPlacementMode(!state.placementMode);
  });
  $("#reportFilter").addEventListener("change", (event) => {
    state.reportFilter = event.target.value;
    state.selectedReportId = null;
    renderReports();
    drawMarkers();
  });
  try {
    await loadTmap();
    state.map = new Tmapv2.Map("adminMap", {
      center: new Tmapv2.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng),
      width: "100%",
      height: "100%",
      zoom: 12,
      httpsMode: true,
    });
    bindMapPlacement();
    $("#adminMapBadge").textContent = "TMAP 연결";
  } catch (error) {
    console.error(error);
    $("#adminMapBadge").textContent = "지도 연결 실패";
    $("#adminMapBadge").classList.add("error");
    $("#adminMap").hidden = true;
    $("#adminMapFallback").hidden = false;
  }
  bindFloodDialog();
  bindHistoryStatisticsDialog();
  await loadReports();
}

function bindFloodDialog() {
  const dialog = $("#adminFloodDialog");
  $("#adminFloodForm").addEventListener("submit", submitAdminFloodPoint);
  $("#closeFloodDialog").addEventListener("click", cancelFloodPlacement);
  $("#cancelFloodPlacement").addEventListener("click", cancelFloodPlacement);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    cancelFloodPlacement();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) cancelFloodPlacement();
  });
}

function bindHistoryStatisticsDialog() {
  const dialog = $("#historyStatisticsDialog");
  $("#closeHistoryStatistics").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}

async function openHistoryStatistics() {
  const dialog = $("#historyStatisticsDialog");
  const button = $("#openHistoryStatistics");
  if (!dialog.open) dialog.showModal();

  button.disabled = true;
  renderHistoryStatisticsLoading();
  try {
    const response = await fetch("/api/admin/flood-statistics/history/dongs");
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "침수이력 통계를 불러오지 못했습니다.");
    }
    state.historyStatistics = payload;
    renderHistoryStatistics(payload);
  } catch (error) {
    renderHistoryStatisticsError(
      error instanceof Error ? error.message : "침수이력 통계를 불러오지 못했습니다."
    );
  } finally {
    button.disabled = false;
  }
}

function resetHistoryStatisticsSummary() {
  $("#historyTotalCount").textContent = "-";
  $("#historyActiveCount").textContent = "-";
  $("#historyResolvedCount").textContent = "-";
  $("#historyTopDong").textContent = "-";
}

function renderHistoryStatisticsLoading() {
  resetHistoryStatisticsSummary();
  const chart = $("#historyStatisticsChart");
  chart.replaceChildren();
  const message = document.createElement("div");
  message.className = "history-chart-message";
  message.textContent = "행정동별 침수이력을 집계하는 중입니다.";
  chart.appendChild(message);
  $("#historyStatisticsNote").textContent = "승인 대기 신고는 통계에서 제외됩니다.";
}

function renderHistoryStatisticsError(message) {
  resetHistoryStatisticsSummary();
  const chart = $("#historyStatisticsChart");
  chart.replaceChildren();
  const error = document.createElement("div");
  error.className = "history-chart-message error";
  error.textContent = message;
  chart.appendChild(error);
}

function renderHistoryStatistics(payload) {
  const metadata = payload.metadata || {};
  const chart = $("#historyStatisticsChart");
  const districts = [...(payload.districts || [])].sort((a, b) => {
    const countDifference = b.totalCount - a.totalCount;
    return countDifference || a.name.localeCompare(b.name, "ko");
  });
  const maxCount = Math.max(1, Number(metadata.maxCount || 0));

  $("#historyTotalCount").textContent = `${metadata.totalCount || 0}건`;
  $("#historyActiveCount").textContent = `${metadata.activeCount || 0}건`;
  $("#historyResolvedCount").textContent = `${metadata.resolvedCount || 0}건`;
  $("#historyTopDong").textContent = metadata.topDongName || "이력 없음";
  chart.replaceChildren();

  if (!metadata.totalCount) {
    const empty = document.createElement("div");
    empty.className = "history-chart-message";
    empty.textContent = "승인된 침수이력이 아직 없습니다.";
    chart.appendChild(empty);
  } else {
    districts.forEach((district) => {
      const row = document.createElement("div");
      row.className = `history-chart-row${district.totalCount ? " has-history" : ""}`;
      row.setAttribute(
        "aria-label",
        `${district.name}: 전체 ${district.totalCount}건, 현재 침수 ${district.activeCount}건, 침수 해제 ${district.resolvedCount}건`
      );

      const name = document.createElement("strong");
      name.textContent = district.name;

      const graph = document.createElement("div");
      graph.className = "history-chart-graph";
      const bar = document.createElement("div");
      bar.className = "history-chart-bar";
      const active = document.createElement("span");
      active.className = "active";
      active.style.width = `${district.activeCount / maxCount * 100}%`;
      active.title = `현재 침수 ${district.activeCount}건`;
      const resolved = document.createElement("span");
      resolved.className = "resolved";
      resolved.style.width = `${district.resolvedCount / maxCount * 100}%`;
      resolved.title = `침수 해제 ${district.resolvedCount}건`;
      bar.append(active, resolved);

      const detail = document.createElement("small");
      detail.textContent = district.totalCount
        ? `현재 ${district.activeCount} · 해제 ${district.resolvedCount}`
        : "이력 없음";
      graph.append(bar, detail);

      const total = document.createElement("b");
      total.textContent = `${district.totalCount}건`;
      row.append(name, graph, total);
      chart.appendChild(row);
    });
  }

  const noteParts = [
    `확정 이력 ${metadata.totalCount || 0}건`,
    `이력이 있는 행정동 ${metadata.affectedDongCount || 0}곳`,
  ];
  if (metadata.unmatchedCount) {
    noteParts.push(`행정동 미확인 ${metadata.unmatchedCount}건`);
  }
  $("#historyStatisticsNote").textContent = `${noteParts.join(" · ")} · 승인 대기 신고 제외`;
}

function bindMapPlacement() {
  if (!state.map) return;
  if (typeof state.map.addListener === "function") {
    state.map.addListener("click", handleMapPlacementClick);
    return;
  }
  if (window.Tmapv2?.event?.addListener) {
    Tmapv2.event.addListener(state.map, "click", handleMapPlacementClick);
  }
}

function readMapPoint(event) {
  const latLng = event?.latLng || event?.latlng || event?.position || event;
  const readValue = (name) => {
    if (typeof latLng?.[name] === "function") return latLng[name]();
    return latLng?.[name] ?? latLng?.[`_${name}`];
  };
  const lat = Number(readValue("lat"));
  const lng = Number(readValue("lng"));
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function handleMapPlacementClick(event) {
  if (!state.placementMode) return;
  const point = readMapPoint(event);
  if (!point) {
    showMapStatus("선택한 지도 좌표를 읽지 못했습니다. 다시 클릭해 주세요.", true);
    return;
  }

  state.pendingPoint = point;
  drawPendingMarker(point);
  $("#adminFloodCoordinates").textContent = `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`;
  $("#adminFloodNote").value = "";
  $("#adminFloodDialog").showModal();
  $("#adminFloodNote").focus();
}

function drawPendingMarker(point) {
  clearPendingMarker();
  if (!state.map || !window.Tmapv2) return;
  state.pendingMarker = new Tmapv2.Marker({
    position: new Tmapv2.LatLng(point.lat, point.lng),
    map: state.map,
    title: "추가할 침수지점",
  });
}

function clearPendingMarker() {
  if (state.pendingMarker) state.pendingMarker.setMap(null);
  state.pendingMarker = null;
}

function setPlacementMode(active) {
  if (active && !state.map) {
    showMapStatus("지도가 연결된 뒤 침수지점을 추가할 수 있습니다.", true);
    return;
  }

  state.placementMode = active;
  const button = $("#startFloodPlacement");
  button.classList.toggle("active", active);
  button.setAttribute("aria-pressed", String(active));
  button.textContent = active ? "지점 선택 취소" : "지도에서 침수 추가";
  $(".admin-map-pane").classList.toggle("placement-mode", active);

  if (active) {
    clearMarkers();
    clearDongPolygons();
    showMapStatus("지도에서 현재 침수지점을 클릭해 주세요.");
  } else {
    state.pendingPoint = null;
    clearPendingMarker();
    drawMarkers();
    showReportSummary();
  }
}

function cancelFloodPlacement() {
  const dialog = $("#adminFloodDialog");
  if (dialog.open) dialog.close();
  setPlacementMode(false);
}

async function submitAdminFloodPoint(event) {
  event.preventDefault();
  if (!state.pendingPoint) return;

  const button = $("#submitFloodPoint");
  button.disabled = true;
  button.textContent = "추가 중";
  try {
    const response = await fetch("/api/admin/flood-zones", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...state.pendingPoint,
        note: $("#adminFloodNote").value.trim(),
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "침수지점을 추가하지 못했습니다.");

    const createdId = payload.report.id;
    $("#adminFloodDialog").close();
    setPlacementMode(false);
    state.reportFilter = "all";
    $("#reportFilter").value = "all";
    state.selectedReportId = createdId;
    await loadReports();
    selectReport(createdId);
    showMapStatus(`관리자 침수 #${createdId}를 현재 침수구역으로 추가했습니다.`);
  } catch (error) {
    showMapStatus(
      error instanceof Error ? error.message : "침수지점을 추가하지 못했습니다.",
      true
    );
  } finally {
    button.disabled = false;
    button.textContent = "현재 침수로 추가";
  }
}

function showMapStatus(message, isError = false) {
  const status = $("#adminMapStatus");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function showReportSummary() {
  const activeCount = state.reports.filter((report) => report.status === "active").length;
  showMapStatus(
    state.reports.length
      ? `신고 ${state.reports.length}건 · 현재 침수 ${activeCount}건을 표시했습니다.`
      : "저장된 신고가 없습니다."
  );
}

function setPanelView(view) {
  state.panelView = view;
  const showReports = view === "reports";
  $("#reportsView").hidden = !showReports;
  $("#dongStatsView").hidden = showReports;
  $("#reportsTab").classList.toggle("active", showReports);
  $("#reportsTab").setAttribute("aria-selected", String(showReports));
  $("#dongStatsTab").classList.toggle("active", !showReports);
  $("#dongStatsTab").setAttribute("aria-selected", String(!showReports));
}

function renderDongStatistics() {
  const payload = state.dongStatistics;
  const list = $("#dongStatsList");
  const legend = $("#dongLegend");
  list.replaceChildren();
  legend.replaceChildren();
  if (!payload) return;

  $("#dongActiveCount").textContent = `${payload.metadata?.activeCount || 0}건`;
  $("#affectedDongCount").textContent = `${payload.metadata?.affectedDongCount || 0}곳`;

  (payload.legend || []).forEach((item) => {
    const label = document.createElement("span");
    const swatch = document.createElement("i");
    swatch.style.background = item.color;
    label.append(swatch, item.label);
    legend.appendChild(label);
  });

  const features = [...(payload.features || [])].sort((a, b) => {
    const countDifference = b.properties.activeCount - a.properties.activeCount;
    return countDifference || a.properties.name.localeCompare(b.properties.name, "ko");
  });
  features.forEach((feature) => {
    const properties = feature.properties;
    const item = document.createElement("button");
    item.type = "button";
    item.className = `dong-stat-item${properties.code === state.selectedDongCode ? " active" : ""}`;

    const heading = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = properties.name;
    const count = document.createElement("span");
    count.className = properties.activeCount ? "has-flood" : "no-flood";
    count.textContent = `${properties.activeCount}건`;
    count.style.setProperty("--dong-color", properties.color);
    heading.append(name, count);

    const breakdown = document.createElement("span");
    breakdown.className = "dong-stat-breakdown";
    const parts = [
      properties.userCount ? `사용자 ${properties.userCount}` : "",
      properties.adminCount ? `관리자 ${properties.adminCount}` : "",
      properties.demoCount ? `데모 ${properties.demoCount}` : "",
    ].filter(Boolean);
    breakdown.textContent = parts.length ? parts.join(" · ") : "현재 침수 없음";
    item.append(heading, breakdown);
    item.addEventListener("click", () => selectDong(properties.code));
    list.appendChild(item);
  });
}

async function loadReports() {
  const button = $("#refreshReports");
  button.disabled = true;
  button.textContent = "불러오는 중";
  try {
    const [response, statisticsResponse] = await Promise.all([
      fetch("/api/admin/reports"),
      fetch("/api/admin/flood-statistics/dongs"),
    ]);
    const [payload, statisticsPayload] = await Promise.all([
      response.json(),
      statisticsResponse.json(),
    ]);
    if (!response.ok) throw new Error(payload.error || "신고 목록을 불러오지 못했습니다.");
    if (!statisticsResponse.ok) {
      throw new Error(statisticsPayload.error || "동별 침수 통계를 불러오지 못했습니다.");
    }

    state.reports = payload.reports || [];
    state.dongStatistics = statisticsPayload;
    state.historyStatistics = null;
    if (!state.reports.some((report) => report.id === state.selectedReportId)) {
      state.selectedReportId = state.reports[0]?.id || null;
    }
    $("#reportCount").textContent = `${payload.count || 0}건`;
    $("#floodHistoryCount").textContent = `${payload.confirmedCount || 0}건`;
    $("#reportsUpdatedAt").textContent = new Intl.DateTimeFormat("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
    if (state.placementMode) {
      showMapStatus("지도에서 현재 침수지점을 클릭해 주세요.");
    } else {
      showReportSummary();
    }
    renderReports();
    renderDongStatistics();
    drawMarkers();
  } catch (error) {
    $("#adminMapStatus").textContent = error instanceof Error
      ? error.message
      : "신고 목록을 불러오지 못했습니다.";
    $("#adminMapStatus").classList.add("error");
  } finally {
    button.disabled = false;
    button.textContent = "새로고침";
  }
}

function visibleReports() {
  if (state.reportFilter === "all") return state.reports;
  if (state.reportFilter === "confirmed") {
    return state.reports.filter((report) => ["active", "resolved"].includes(report.status));
  }
  if (state.reportFilter === "demo") {
    return state.reports.filter((report) => report.isSample);
  }
  if (state.reportFilter === "admin") {
    return state.reports.filter((report) => report.isAdminCreated);
  }
  return state.reports.filter((report) => report.status === state.reportFilter);
}

function renderReports() {
  const list = $("#reportsList");
  list.replaceChildren();
  const reports = visibleReports();
  if (!reports.some((report) => report.id === state.selectedReportId)) {
    state.selectedReportId = reports[0]?.id || null;
  }
  if (!reports.length) {
    const empty = document.createElement("div");
    empty.className = "reports-empty";
    empty.textContent = state.reports.length
      ? "선택한 상태의 신고가 없습니다."
      : "접수된 위치 신고가 없습니다.";
    list.appendChild(empty);
    renderSelectedReport(null);
    return;
  }

  reports.forEach((report) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `report-item${report.isSample ? " sample" : ""}${report.isAdminCreated ? " admin-created" : ""}${report.id === state.selectedReportId ? " active" : ""}`;

    const heading = document.createElement("div");
    heading.className = "report-item-heading";
    const number = document.createElement("strong");
    number.textContent = reportLabel(report);
    const status = document.createElement("span");
    status.className = `report-status status-${report.status}`;
    status.textContent = STATUS_LABELS[report.status] || report.status;
    heading.append(number, status);

    const coordinate = document.createElement("div");
    coordinate.className = "report-coordinate";
    coordinate.textContent = `${report.lat.toFixed(6)}, ${report.lng.toFixed(6)}`;
    const time = document.createElement("span");
    time.className = "report-meta";
    time.textContent = `${report.isAdminCreated ? "등록" : "신고"} ${formatDate(report.createdAt)}`;
    item.append(heading, coordinate, time);

    if (report.note) {
      const note = document.createElement("div");
      note.className = "report-note-preview";
      note.textContent = report.note;
      item.appendChild(note);
    }
    item.addEventListener("click", () => selectReport(report.id));
    list.appendChild(item);
  });

  renderSelectedReport(
    reports.find((report) => report.id === state.selectedReportId) || null
  );
}

function renderSelectedReport(report) {
  const selected = $("#selectedReport");
  selected.replaceChildren();
  if (!report) {
    selected.className = "selected-report empty";
    selected.textContent = "지도 또는 목록에서 신고를 선택하세요.";
    return;
  }

  selected.className = `selected-report${report.isSample ? " sample" : ""}${report.isAdminCreated ? " admin-created" : ""}`;
  const heading = document.createElement("div");
  heading.className = "selected-report-heading";
  const title = document.createElement("strong");
  title.textContent = reportLabel(report, true);
  const status = document.createElement("span");
  status.className = `report-status status-${report.status}`;
  status.textContent = STATUS_LABELS[report.status] || report.status;
  heading.append(title, status);
  const coordinate = document.createElement("span");
  coordinate.textContent = `${report.lat.toFixed(6)}, ${report.lng.toFixed(6)}`;
  const meta = document.createElement("span");
  const accuracy = report.accuracyM === null
    ? "정확도 정보 없음"
    : `GPS 정확도 약 ${Math.round(report.accuracyM)} m`;
  meta.textContent = `${report.isAdminCreated ? "등록" : "신고"} ${formatDate(report.createdAt)} · ${accuracy}`;
  selected.append(heading, coordinate, meta);
  if (report.isSample) {
    const source = document.createElement("span");
    source.className = "sample-source";
    source.textContent = "실제 침수흔적 내부에서 추출한 데모 데이터";
    selected.appendChild(source);
  }
  if (report.isAdminCreated) {
    const source = document.createElement("span");
    source.className = "admin-source";
    source.textContent = "관리자가 지도에서 직접 추가한 침수지점";
    selected.appendChild(source);
  }
  if (report.approvedAt) {
    const approved = document.createElement("span");
    approved.textContent = `승인 ${formatDate(report.approvedAt)}`;
    selected.appendChild(approved);
  }
  if (report.resolvedAt) {
    const resolved = document.createElement("span");
    resolved.textContent = `해제 ${formatDate(report.resolvedAt)}`;
    selected.appendChild(resolved);
  }
  if (report.note) {
    const note = document.createElement("p");
    note.textContent = report.note;
    selected.appendChild(note);
  }

  const action = document.createElement("button");
  action.type = "button";
  action.className = report.status === "active"
    ? "report-state-action resolve"
    : "report-state-action approve";
  action.textContent = report.status === "active"
    ? "침수 해제"
    : report.status === "resolved" ? "재승인" : "침수 승인";
  action.addEventListener("click", () => updateReportStatus(
    report.id,
    report.status === "active" ? "resolve" : "approve",
    action
  ));
  selected.appendChild(action);
}

async function updateReportStatus(id, action, button) {
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "처리 중";
  try {
    const response = await fetch(`/api/admin/reports/${id}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "신고 상태를 변경하지 못했습니다.");
    await loadReports();
    $("#adminMapStatus").textContent = action === "approve"
      ? `신고 #${id}를 현재 침수구역으로 승인했습니다.`
      : `신고 #${id}의 침수 상태를 해제했습니다.`;
    $("#adminMapStatus").classList.remove("error");
  } catch (error) {
    $("#adminMapStatus").textContent = error instanceof Error
      ? error.message
      : "신고 상태를 변경하지 못했습니다.";
    $("#adminMapStatus").classList.add("error");
    button.disabled = false;
    button.textContent = originalText;
  }
}

function clearMarkers() {
  state.markers.forEach((marker) => marker.setMap(null));
  state.markers = [];
}

function geometryPolygons(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

function clearDongPolygons() {
  state.dongPolygons.forEach((polygon) => polygon.setMap(null));
  state.dongPolygons = [];
}

function drawDongPolygons() {
  clearDongPolygons();
  if (!state.map || !window.Tmapv2 || !state.dongStatistics) return;

  (state.dongStatistics.features || []).forEach((feature) => {
    const properties = feature.properties;
    const isSelected = properties.code === state.selectedDongCode;
    geometryPolygons(feature.geometry).forEach((polygonCoordinates) => {
      const exterior = polygonCoordinates[0] || [];
      if (exterior.length < 3) return;
      const layer = new Tmapv2.Polygon({
        paths: exterior.map(([lng, lat]) => new Tmapv2.LatLng(lat, lng)),
        map: state.map,
        fillColor: properties.color,
        fillOpacity: Math.min(
          0.58,
          Number(properties.fillOpacity || 0.06) + (isSelected ? 0.1 : 0)
        ),
        strokeColor: isSelected ? "#0f4556" : properties.color,
        strokeOpacity: properties.activeCount ? 0.9 : 0.42,
        strokeWeight: isSelected ? 4 : properties.activeCount ? 2 : 1,
      });
      const handleClick = () => {
        if (!state.placementMode) selectDong(properties.code);
      };
      if (typeof layer.addListener === "function") {
        layer.addListener("click", handleClick);
      } else if (window.Tmapv2?.event?.addListener) {
        Tmapv2.event.addListener(layer, "click", handleClick);
      }
      state.dongPolygons.push(layer);
    });
  });
}

function drawMarkers() {
  clearMarkers();
  if (state.placementMode) {
    clearDongPolygons();
    return;
  }
  drawDongPolygons();
  const reports = visibleReports();
  if (!state.map || !window.Tmapv2 || !reports.length) return;

  const bounds = new Tmapv2.LatLngBounds();
  reports.forEach((report) => {
    const position = new Tmapv2.LatLng(report.lat, report.lng);
    const marker = new Tmapv2.Marker({
      position,
      map: state.map,
      title: reportLabel(report),
    });
    if (typeof marker.addListener === "function") {
      marker.addListener("click", () => selectReport(report.id));
    }
    bounds.extend(position);
    state.markers.push(marker);
  });

  if (reports.length === 1) {
    state.map.setCenter(new Tmapv2.LatLng(reports[0].lat, reports[0].lng));
    state.map.setZoom(15);
  } else {
    try {
      state.map.fitBounds(bounds);
    } catch {
      state.map.setCenter(new Tmapv2.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng));
    }
  }
}

function selectReport(id) {
  const report = state.reports.find((item) => item.id === id);
  if (!report) return;
  setPanelView("reports");
  state.selectedReportId = id;
  renderReports();
  if (state.map) {
    state.map.setCenter(new Tmapv2.LatLng(report.lat, report.lng));
    state.map.setZoom(16);
  }
}

function selectDong(code) {
  const feature = state.dongStatistics?.features?.find(
    (item) => item.properties.code === code
  );
  if (!feature) return;
  state.selectedDongCode = code;
  setPanelView("dongs");
  renderDongStatistics();
  drawDongPolygons();

  if (state.map) {
    const bounds = new Tmapv2.LatLngBounds();
    geometryPolygons(feature.geometry).forEach((polygonCoordinates) => {
      (polygonCoordinates[0] || []).forEach(([lng, lat]) => {
        bounds.extend(new Tmapv2.LatLng(lat, lng));
      });
    });
    try {
      state.map.fitBounds(bounds);
    } catch {
      state.map.setCenter(
        new Tmapv2.LatLng(feature.properties.centerLat, feature.properties.centerLng)
      );
      state.map.setZoom(13);
    }
  }

  window.setTimeout(() => {
    $("#dongStatsList .dong-stat-item.active")?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, 0);
}

initialize().catch((error) => {
  console.error(error);
  $("#adminMapStatus").textContent = "관리자 화면을 초기화하지 못했습니다.";
  $("#adminMapStatus").classList.add("error");
});
