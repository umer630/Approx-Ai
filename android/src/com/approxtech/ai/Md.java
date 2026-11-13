package com.approxtech.ai;

import android.graphics.Color;
import android.graphics.Typeface;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.BackgroundColorSpan;
import android.text.style.BulletSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.LeadingMarginSpan;
import android.text.style.RelativeSizeSpan;
import android.text.style.StyleSpan;
import android.text.style.TypefaceSpan;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Markdown → Spanned for AI answers. Text only (no HTML is ever interpreted). Supports: # / ## / ### headings,
 * **bold**, *italic*, `inline code`, ``` fenced code blocks ```, - / * bullet lists, 1. numbered lists, and
 * | pipe | tables |. Fenced code blocks are returned as separate CodeBlock segments so the UI can render each
 * with its own monospace card + a Copy button.
 */
final class Md {
    private static final Pattern BOLD = Pattern.compile("\\*\\*([^*]+)\\*\\*");
    private static final Pattern ITALIC = Pattern.compile("(?<![\\*\\w])\\*([^*\\n]+)\\*(?!\\*)|(?<![_\\w])_([^_\\n]+)_(?!\\w)");
    private static final Pattern CODE = Pattern.compile("`([^`]+)`");
    private static final int CODE_BG = Color.parseColor("#0F1C34");
    private static final int INLINE_BG = Color.parseColor("#15274A");
    private static final int CODE_FG = Color.parseColor("#DFE8F5");
    private static final int MUTED = Color.parseColor("#93A3BF");
    private static final int ACCENT = Color.parseColor("#22D37A");

    /** One rendered piece: either prose (Spanned) or a fenced code block (so the UI can add a Copy button). */
    static final class Segment {
        final boolean code;
        final CharSequence text;   // for prose: the Spanned; for code: the raw code string
        final String lang;         // code only
        Segment(boolean code, CharSequence text, String lang) { this.code = code; this.text = text; this.lang = lang; }
    }

    /** Split into prose + code-block segments. The UI renders each; code blocks get a monospace card + Copy. */
    static List<Segment> segments(String src) {
        List<Segment> segs = new ArrayList<>();
        String[] parts = src.split("```", -1);
        for (int i = 0; i < parts.length; i++) {
            if (i % 2 == 1) {
                String block = parts[i];
                int nl = block.indexOf('\n');
                String lang = nl >= 0 && block.substring(0, nl).trim().matches("[\\w+#.-]*") ? block.substring(0, nl).trim() : "";
                String code = nl >= 0 && !lang.isEmpty() ? block.substring(nl + 1) : (nl >= 0 && block.substring(0, nl).trim().isEmpty() ? block.substring(nl + 1) : block);
                code = code.replaceAll("\\n$", "");
                segs.add(new Segment(true, code, lang));
            } else if (!parts[i].isEmpty()) {
                segs.add(new Segment(false, renderProse(parts[i]), null));
            }
        }
        if (segs.isEmpty()) segs.add(new Segment(false, "", null));
        return segs;
    }

    /** Backwards-compatible single-span render (used where segments aren't needed). */
    static CharSequence render(String src) {
        SpannableStringBuilder out = new SpannableStringBuilder();
        for (Segment s : segments(src)) {
            if (s.code) {
                int st = out.length();
                out.append(s.text).append("\n");
                mono(out, st, out.length());
            } else {
                out.append(s.text).append("\n");
            }
        }
        trimTrailing(out);
        return out;
    }

    private static CharSequence renderProse(String src) {
        SpannableStringBuilder out = new SpannableStringBuilder();
        String[] lines = src.split("\n", -1);
        int n = 0;
        while (n < lines.length) {
            String line = lines[n];
            // table: a header row followed by a |---|---| separator
            if (isTableRow(line) && n + 1 < lines.length && isTableDivider(lines[n + 1])) {
                List<String[]> rows = new ArrayList<>();
                rows.add(splitRow(line));
                n += 2;
                while (n < lines.length && isTableRow(lines[n])) { rows.add(splitRow(lines[n])); n++; }
                appendTable(out, rows);
                continue;
            }
            appendLine(out, line);
            out.append("\n");
            n++;
        }
        trimTrailing(out);
        return out;
    }

    private static void appendLine(SpannableStringBuilder out, String line) {
        int s = out.length();
        String l = line;
        boolean heading = l.matches("^#{1,3}\\s+.*");
        int hlevel = 0;
        if (heading) { hlevel = l.length() - l.replaceFirst("^#+", "").length(); l = l.replaceFirst("^#{1,3}\\s+", ""); }

        Matcher num = Pattern.compile("^(\\s*)(\\d+)\\.\\s+(.*)").matcher(l);
        Matcher bul = Pattern.compile("^(\\s*)[-*]\\s+(.*)").matcher(l);
        if (num.matches()) {
            String prefix = num.group(2) + ".  ";
            int ps = out.length();
            out.append(prefix);
            out.setSpan(new ForegroundColorSpan(ACCENT), ps, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            appendInline(out, num.group(3));
            out.setSpan(new LeadingMarginSpan.Standard(0, dp(18)), s, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        } else if (bul.matches()) {
            appendInline(out, bul.group(2));
            out.setSpan(new BulletSpan(dp(10), ACCENT), s, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            out.setSpan(new LeadingMarginSpan.Standard(dp(4), dp(18)), s, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        } else {
            appendInline(out, l);
        }
        if (heading) {
            out.setSpan(new StyleSpan(Typeface.BOLD), s, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            out.setSpan(new RelativeSizeSpan(hlevel == 1 ? 1.35f : hlevel == 2 ? 1.2f : 1.1f), s, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
    }

    // ---- tables ----
    private static boolean isTableRow(String l) { return l.trim().startsWith("|") && l.trim().endsWith("|") && l.indexOf('|', 1) > 0; }
    private static boolean isTableDivider(String l) { return l.trim().matches("\\|?[:\\- |]+\\|?") && l.contains("-"); }

    private static String[] splitRow(String l) {
        String t = l.trim();
        if (t.startsWith("|")) t = t.substring(1);
        if (t.endsWith("|")) t = t.substring(0, t.length() - 1);
        String[] cells = t.split("\\|", -1);
        for (int i = 0; i < cells.length; i++) cells[i] = cells[i].trim();
        return cells;
    }

    private static void appendTable(SpannableStringBuilder out, List<String[]> rows) {
        int cols = 0;
        for (String[] r : rows) cols = Math.max(cols, r.length);
        int[] w = new int[cols];
        for (String[] r : rows) for (int c = 0; c < r.length; c++) w[c] = Math.max(w[c], r[c].length());
        for (int ri = 0; ri < rows.size(); ri++) {
            String[] r = rows.get(ri);
            int s = out.length();
            StringBuilder sb = new StringBuilder();
            for (int c = 0; c < cols; c++) {
                String cell = c < r.length ? r[c] : "";
                sb.append(pad(cell, w[c] + 2));
            }
            out.append(sb.toString().replaceAll("\\s+$", "")).append("\n");
            out.setSpan(new TypefaceSpan("monospace"), s, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            if (ri == 0) out.setSpan(new StyleSpan(Typeface.BOLD), s, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            else out.setSpan(new ForegroundColorSpan(CODE_FG), s, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
    }

    private static String pad(String s, int n) {
        StringBuilder b = new StringBuilder(s);
        while (b.length() < n) b.append(' ');
        return b.toString();
    }

    // ---- inline: bold, italic, inline code ----
    private static void appendInline(SpannableStringBuilder out, String line) {
        Matcher m = BOLD.matcher(line);
        int last = 0;
        while (m.find()) {
            appendItalic(out, line.substring(last, m.start()));
            int s = out.length();
            appendItalic(out, m.group(1));
            out.setSpan(new StyleSpan(Typeface.BOLD), s, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            last = m.end();
        }
        appendItalic(out, line.substring(last));
    }

    private static void appendItalic(SpannableStringBuilder out, String text) {
        Matcher m = ITALIC.matcher(text);
        int last = 0;
        while (m.find()) {
            appendCode(out, text.substring(last, m.start()));
            int s = out.length();
            appendCode(out, m.group(1) != null ? m.group(1) : m.group(2));
            out.setSpan(new StyleSpan(Typeface.ITALIC), s, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            last = m.end();
        }
        appendCode(out, text.substring(last));
    }

    private static void appendCode(SpannableStringBuilder out, String text) {
        Matcher m = CODE.matcher(text);
        int last = 0;
        while (m.find()) {
            out.append(text, last, m.start());
            int s = out.length();
            out.append(m.group(1));
            out.setSpan(new TypefaceSpan("monospace"), s, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            out.setSpan(new BackgroundColorSpan(INLINE_BG), s, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            last = m.end();
        }
        out.append(text.substring(last));
    }

    private static void mono(SpannableStringBuilder out, int s, int e) {
        out.setSpan(new TypefaceSpan("monospace"), s, e, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        out.setSpan(new BackgroundColorSpan(CODE_BG), s, e, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        out.setSpan(new ForegroundColorSpan(CODE_FG), s, e, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    }

    private static void trimTrailing(SpannableStringBuilder out) {
        while (out.length() > 0 && out.charAt(out.length() - 1) == '\n') out.delete(out.length() - 1, out.length());
    }

    private static int dp(int v) { return Math.round(v * android.content.res.Resources.getSystem().getDisplayMetrics().density); }
}
