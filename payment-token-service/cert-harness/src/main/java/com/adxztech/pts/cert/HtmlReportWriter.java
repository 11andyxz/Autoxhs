package com.adxztech.pts.cert;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * Renders a suite result as a self-contained HTML report (S10.5).
 *
 * <p>The report is the deliverable an issuer's integration team actually receives, so it shows the request
 * that was sent and every observed value -- not just PASS or FAIL. A report that says "step 4 failed" and
 * nothing else generates an email thread; one that says "expected de39 00 but was 54, and here is the
 * request" ends the conversation.
 */
public class HtmlReportWriter {

    private static final Logger log = LoggerFactory.getLogger(HtmlReportWriter.class);

    public String render(SuiteRunner.SuiteResult result) {
        StringBuilder html = new StringBuilder(8192);
        String verdict = result.allPassed() ? "PASS" : "FAIL";
        String verdictColour = result.allPassed() ? "#1a7f37" : "#b42318";

        html.append("<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">")
                .append("<title>Certification report: ").append(escape(result.suiteName())).append("</title>")
                .append("<style>")
                .append("body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:2rem;color:#111}")
                .append("h1{font-size:1.4rem;margin-bottom:.2rem}")
                .append(".meta{color:#555;margin-bottom:1.2rem}")
                .append(".verdict{display:inline-block;padding:.2rem .6rem;border-radius:4px;color:#fff;")
                .append("font-weight:600;background:").append(verdictColour).append("}")
                .append("table{border-collapse:collapse;width:100%;margin-top:1rem}")
                .append("th,td{border:1px solid #d8dbe0;padding:.45rem .6rem;text-align:left;vertical-align:top}")
                .append("th{background:#f6f8fa}")
                .append("tr.pass td:first-child{border-left:4px solid #1a7f37}")
                .append("tr.fail td:first-child{border-left:4px solid #b42318}")
                .append("tr.skip td:first-child{border-left:4px solid #9a6700}")
                .append("code{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}")
                .append(".fail-detail{color:#b42318;font-weight:600}")
                .append("</style></head><body>");

        html.append("<h1>Certification report: ").append(escape(result.suiteName())).append("</h1>");
        html.append("<div class=\"meta\"><span class=\"verdict\">").append(verdict).append("</span>&nbsp; ")
                .append(result.passed()).append(" passed, ")
                .append(result.failed()).append(" failed, ")
                .append(result.skipped()).append(" skipped &middot; ")
                .append(result.durationMs()).append(" ms &middot; issuer <b>")
                .append(escape(result.issuerId())).append("</b><br>")
                .append("executor: ").append(escape(result.executor())).append("<br>")
                .append("generated ").append(Instant.now());
        if (result.description() != null && !result.description().isBlank()) {
            html.append("<br>").append(escape(result.description()));
        }
        html.append("</div>");

        html.append("<table><thead><tr>")
                .append("<th>Step</th><th>Action</th><th>Result</th><th>ms</th>")
                .append("<th>Request</th><th>Observed</th>")
                .append("</tr></thead><tbody>");

        for (SuiteRunner.StepResult step : result.steps()) {
            String rowClass = step.passed() ? "pass"
                    : (step.failures().size() == 1 && step.failures().get(0).startsWith("skipped")
                        ? "skip" : "fail");
            html.append("<tr class=\"").append(rowClass).append("\">");
            html.append("<td><b>").append(escape(step.id())).append("</b>");
            if (step.description() != null && !step.description().isBlank()) {
                html.append("<br><span style=\"color:#555\">").append(escape(step.description()))
                        .append("</span>");
            }
            html.append("</td>");
            html.append("<td><code>").append(escape(step.action())).append("</code></td>");
            html.append("<td>");
            if (step.passed()) {
                html.append("PASS");
            } else {
                html.append("<span class=\"fail-detail\">").append(rowClass.equals("skip") ? "SKIP" : "FAIL")
                        .append("</span><ul>");
                for (String failure : step.failures()) {
                    html.append("<li>").append(escape(failure)).append("</li>");
                }
                html.append("</ul>");
            }
            html.append("</td>");
            html.append("<td>").append(step.durationMs()).append("</td>");
            html.append("<td><code>").append(escape(renderMap(step.request()))).append("</code></td>");
            html.append("<td><code>").append(escape(renderMap(step.actual()))).append("</code></td>");
            html.append("</tr>");
        }

        html.append("</tbody></table>");
        html.append("<p style=\"color:#555;margin-top:1.5rem\">Supported actions: ")
                .append(escape(String.join(", ", HttpStepExecutor.supportedActions())))
                .append("</p>");
        html.append("</body></html>");
        return html.toString();
    }

    public Path write(SuiteRunner.SuiteResult result, Path outputDirectory) throws IOException {
        Files.createDirectories(outputDirectory);
        String fileName = "cert-report-" + slug(result.suiteName()) + ".html";
        Path target = outputDirectory.resolve(fileName);
        Files.writeString(target, render(result), StandardCharsets.UTF_8);
        log.info("certification report written to {}", target.toAbsolutePath());
        return target;
    }

    private static String renderMap(Map<String, Object> map) {
        if (map == null || map.isEmpty()) {
            return "-";
        }
        StringBuilder sb = new StringBuilder();
        map.forEach((key, value) -> sb.append(key).append(": ").append(renderValue(value)).append('\n'));
        return sb.toString().trim();
    }

    private static String renderValue(Object value) {
        if (value instanceof List<?> list) {
            return list.toString();
        }
        // Never render anything that could be a PAN in full: the report is an emailed artefact.
        String text = String.valueOf(value);
        return text.matches("\\d{12,19}") ? com.adxztech.pts.common.pan.Pan.mask(text) : text;
    }

    private static String slug(String name) {
        return name.toLowerCase(java.util.Locale.ROOT).replaceAll("[^a-z0-9]+", "-")
                .replaceAll("(^-|-$)", "");
    }

    private static String escape(String text) {
        if (text == null) {
            return "";
        }
        return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;");
    }
}
