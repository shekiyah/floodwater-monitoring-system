// Applies the site's palette and fonts to every Chart.js chart.
// Load after Chart.js and before the page script that builds charts.

(function () {

    if (typeof Chart === "undefined") {
        return;
    }

    const css = getComputedStyle(document.documentElement);
    const token = name => css.getPropertyValue(name).trim();

    Chart.defaults.font.family = token("--font-body");
    Chart.defaults.font.size = 12;
    Chart.defaults.color = token("--ink-soft");
    Chart.defaults.borderColor = "rgba(14, 59, 77, 0.10)";

    Chart.defaults.plugins.tooltip.backgroundColor = token("--river-deep");
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.tooltip.cornerRadius = 6;
    Chart.defaults.plugins.tooltip.titleFont = { weight: "600" };

    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.plugins.legend.labels.boxWidth = 8;

    // Web fonts may arrive after the first paint; redraw once they do
    // so axis labels don't stay in the fallback face.
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
            Object.values(Chart.instances).forEach(chart => chart.update("none"));
        });
    }

})();