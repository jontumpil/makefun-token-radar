(function () {
  "use strict";
  var R = window.RADAR;
  if (!R) return;
  var rows = R.rows;
  var state = { q: "", cat: "", verdict: "", watch: false, key: "rank", dir: 1 };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtUsd(n) {
    if (n === null || n === undefined) return "—";
    var s = String(Math.round(Math.abs(n)));
    var out = "";
    for (var i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 === 0) out += ",";
      out += s[i];
    }
    return (n < 0 ? "-$" : "$") + out;
  }
  function fmtPct(v) {
    if (v === null || v === undefined) return "—";
    return (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return "—";
    return (days / 365.25).toFixed(1);
  }
  function mult(m) {
    return m.typicalMultiple.toFixed(2) + "x typical multiple, " +
      (m.within2x * 100).toFixed(0) + "% within 2x (n=" + m.n + ")";
  }

  // Header, integrity strip and KPIs: every figure comes from data.js.
  $("asof").textContent = R.as_of;
  $("trained-on").textContent = R.model.trainedOn;
  var V = R.model.validation;
  $("val-a").textContent = mult(V.chosen.heldoutA);
  $("val-b").textContent = mult(V.chosen.heldoutB);
  $("val-wf").textContent = mult(V.chosen.walkForward);
  $("val-loo").textContent = mult(V.chosen.loo);
  $("val-ga").textContent = mult(V.growthVariant.heldoutA);
  $("val-gb").textContent = mult(V.growthVariant.heldoutB);
  $("acct").textContent = R.counts.scanned;
  $("acct-traded").textContent = R.counts.traded;
  $("acct-board").textContent = R.counts.boardRows;
  $("acct-aside").textContent = R.counts.setAside;
  $("kpi-scanned").textContent = R.counts.scanned;
  $("kpi-rows").textContent = R.counts.boardRows;
  $("kpi-watch").textContent = R.counts.watchlistCovered + "/" + R.counts.watchlist;
  $("kpi-ff").textContent = rows.filter(function (r) { return r.verdict === "FARM FIRST"; }).length;
  var imp = rows.map(function (r) { return r.implied_value_usd; }).sort(function (a, b) { return a - b; });
  var med = imp.length % 2 === 1 ? imp[(imp.length - 1) / 2] : Math.round((imp[imp.length / 2 - 1] + imp[imp.length / 2]) / 2);
  $("kpi-median").textContent = fmtUsd(med);

  var cats = [];
  rows.forEach(function (r) { if (cats.indexOf(r.category) === -1) cats.push(r.category); });
  cats.sort();
  var catSel = $("cat");
  cats.forEach(function (c) {
    var o = document.createElement("option");
    o.value = c; o.textContent = c;
    catSel.appendChild(o);
  });

  function sortVal(r, key) {
    if (key === "peer") return r.peer.share;
    if (key === "tvl_usd" || key === "change_7d" || key === "ageDays") {
      var v = r[key];
      return v === null || v === undefined ? -1e18 : v;
    }
    return r[key];
  }

  function visible() {
    var q = state.q.toLowerCase();
    var out = rows.filter(function (r) {
      if (state.cat && r.category !== state.cat) return false;
      if (state.verdict && r.verdict !== state.verdict) return false;
      if (state.watch && !r.watchlist) return false;
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    out.sort(function (a, b) {
      var va = sortVal(a, state.key), vb = sortVal(b, state.key);
      if (typeof va === "string") return state.dir * (va < vb ? -1 : va > vb ? 1 : a.slug < b.slug ? -1 : 1);
      if (va !== vb) return state.dir * (va - vb);
      return a.slug < b.slug ? -1 : 1;
    });
    return out;
  }

  function badgeClass(v) {
    return v === "FARM FIRST" ? "ff" : v === "FARM" ? "farm" : v === "WATCH" ? "watch" : "skip";
  }

  function render() {
    var vis = visible();
    var html = "";
    vis.forEach(function (r) {
      html += "<tr data-slug=\"" + esc(r.slug) + "\">" +
        "<td>" + r.rank + "</td>" +
        "<td><span class=\"name\">" + esc(r.name) + "</span>" +
        (r.watchlist ? "<span class=\"wl\">watchlist</span>" : "") +
        "<br><span class=\"slug\">" + esc(r.slug) + "</span></td>" +
        "<td>" + esc(r.category) + "</td>" +
        "<td class=\"num\">" + fmtUsd(r.tvl_usd) + "</td>" +
        "<td class=\"num " + (r.change_7d !== null && r.change_7d < 0 ? "neg" : "pos") + "\">" + fmtPct(r.change_7d) + "</td>" +
        "<td class=\"num\">" + fmtAge(r.ageDays) + "</td>" +
        "<td class=\"num\">" + r.peer.traded + "/" + r.peer.total + " (" + Math.round(r.peer.share * 100) + "%)</td>" +
        "<td class=\"num\">" + fmtUsd(r.implied_value_usd) + "</td>" +
        "<td><span class=\"badge " + badgeClass(r.verdict) + "\">" + esc(r.verdict) + "</span></td>" +
        "</tr>";
    });
    $("rows").innerHTML = html;
    $("rowcount").textContent = vis.length + " of " + rows.length + " rows";
  }

  $("q").addEventListener("input", function (e) { state.q = e.target.value; render(); });
  catSel.addEventListener("change", function (e) { state.cat = e.target.value; render(); });
  $("verdict").addEventListener("change", function (e) { state.verdict = e.target.value; render(); });
  $("watchonly").addEventListener("change", function (e) { state.watch = e.target.checked; render(); });
  var ths = document.querySelectorAll("#board th");
  ths.forEach(function (th) {
    th.addEventListener("click", function () {
      var key = th.getAttribute("data-key");
      if (state.key === key) state.dir = -state.dir;
      else { state.key = key; state.dir = key === "name" || key === "category" || key === "verdict" ? 1 : -1; }
      if (key === "rank") state.dir = 1;
      render();
    });
  });

  function openDetail(slug) {
    var r = null;
    rows.forEach(function (x) { if (x.slug === slug) r = x; });
    var panel = $("detail");
    if (!r) { panel.className = "detail hidden"; panel.innerHTML = ""; return; }
    var t = r.terms;
    var sum = t.intercept + t.tvlTerm + t.ageTerm + t.chainsTerm + t.catOffset;
    var months = Math.ceil(r.costs.weeks / 4);
    var stepsHtml = r.farm_steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("");
    panel.innerHTML =
      "<button class=\"close-btn\" id=\"detail-close\">close</button>" +
      "<h3>#" + r.rank + " " + esc(r.name) + " <span class=\"badge " + badgeClass(r.verdict) + "\">" + esc(r.verdict) + "</span></h3>" +
      "<p class=\"meta\">" + esc(r.category) + " · chains: " + esc(r.chains.join(", ")) +
      " · TVL " + fmtUsd(r.tvl_usd) + " · 7d " + fmtPct(r.change_7d) +
      " · age " + (r.ageDays === null ? "unknown" : r.ageDays + " days") +
      (r.watchlist ? " · on the watchlist" : "") + "</p>" +
      "<h4>Model decomposition (log10 terms)</h4>" +
      "<div class=\"terms\">" +
      "<div class=\"term\"><div class=\"t-label\">Intercept</div><div class=\"t-val\">" + t.intercept.toFixed(3) + "</div></div>" +
      "<div class=\"term\"><div class=\"t-label\">TVL term</div><div class=\"t-val\">" + t.tvlTerm.toFixed(3) + "</div></div>" +
      "<div class=\"term\"><div class=\"t-label\">Age term</div><div class=\"t-val\">" + t.ageTerm.toFixed(3) + "</div></div>" +
      "<div class=\"term\"><div class=\"t-label\">Chains term</div><div class=\"t-val\">" + t.chainsTerm.toFixed(3) + "</div></div>" +
      "<div class=\"term\"><div class=\"t-label\">Category offset</div><div class=\"t-val\">" + t.catOffset.toFixed(3) + "</div></div>" +
      "<div class=\"term\"><div class=\"t-label\">Sum → implied</div><div class=\"t-val\">" + sum.toFixed(3) + " → " + fmtUsd(r.implied_value_usd) + "</div></div>" +
      "</div>" +
      "<h4>Peer record</h4>" +
      "<p>In " + esc(r.category) + ", " + r.peer.traded + " of " + r.peer.total +
      " protocols already trade (" + (r.peer.share * 100).toFixed(1) + "%). " +
      (r.verdict === "FARM FIRST"
        ? "That record, with an implied value at or above $25,000,000, earns the FARM FIRST verdict."
        : "The verdict follows the implied value bands, with the peer record gating FARM FIRST.") + "</p>" +
      "<h4>Farm plan (estimate)</h4>" +
      "<ol class=\"plan\">" + stepsHtml + "</ol>" +
      "<p class=\"plan-total\">Plan cost: setup " + fmtUsd(r.costs.setup) + " + " +
      fmtUsd(r.costs.monthly) + "/month x " + months + " months = " + fmtUsd(r.costs.total) +
      " over " + r.costs.weeks + " weeks, with " + fmtUsd(r.costs.capital) + " of working capital.</p>";
    panel.className = "detail";
    $("detail-close").addEventListener("click", function () {
      panel.className = "detail hidden";
      panel.innerHTML = "";
    });
    if (!document.body.classList.contains("detail-focus")) {
      panel.scrollIntoView({ block: "nearest" });
    }
  }

  $("rows").addEventListener("click", function (e) {
    var tr = e.target.closest ? e.target.closest("tr[data-slug]") : null;
    if (tr) openDetail(tr.getAttribute("data-slug"));
  });

  var params = new URLSearchParams(window.location.search);
  if (params.get("filter") === "watchlist") {
    state.watch = true;
    $("watchonly").checked = true;
  }
  render();
  if (params.get("detail")) {
    // Focus mode for deep links: the detail panel moves above the table and
    // the cover strips collapse, so the breakdown opens in view.
    document.body.classList.add("detail-focus");
    var panel = $("detail");
    panel.parentNode.insertBefore(panel, $("board"));
    openDetail(params.get("detail"));
  }
})();
