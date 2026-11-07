package com.approxtech.ai;

import android.graphics.Color;
import android.graphics.Typeface;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.BackgroundColorSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.RelativeSizeSpan;
import android.text.style.StyleSpan;
import android.text.style.TypefaceSpan;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Minimal Markdown → Spanned (code blocks, inline code, bold, headings, bullets). Text only: no HTML. */
final class Md {
    private static final Pattern BOLD = Pattern.compile("\\*\\*([^*]+)\\*\\*");
    private static final Pattern CODE = Pattern.compile("`([^`]+)`");

    static CharSequence render(String src) {
        SpannableStringBuilder out = new SpannableStringBuilder();
        String[] parts = src.split("```", -1);
        for (int i = 0; i < parts.length; i++) {
            if (i % 2 == 1) {
                String block = parts[i];
                int nl = block.indexOf('\n');
                String code = nl >= 0 && block.substring(0, nl).matches("[\\w+#.-]*") ? block.substring(nl + 1) : block;
                code = code.replaceAll("\\n$", "");
                int s = out.length();
                out.append(code).append("\n");
                out.setSpan(new TypefaceSpan("monospace"), s, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                out.setSpan(new BackgroundColorSpan(Color.parseColor("#0F1C34")), s, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                out.setSpan(new ForegroundColorSpan(Color.parseColor("#DFE8F5")), s, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            } else {
                for (String line : parts[i].split("\n", -1)) {
                    int s = out.length();
                    String l = line;
                    boolean heading = l.matches("^#{1,3}\\s+.*");
                    if (heading) l = l.replaceFirst("^#{1,3}\\s+", "");
                    if (l.matches("^\\s*[-*]\\s+.*")) l = "  •  " + l.replaceFirst("^\\s*[-*]\\s+", "");
                    appendInline(out, l);
                    if (heading) {
                        out.setSpan(new StyleSpan(Typeface.BOLD), s, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                        out.setSpan(new RelativeSizeSpan(1.15f), s, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                    }
                    out.append("\n");
                }
            }
        }
        while (out.length() > 0 && out.charAt(out.length() - 1) == '\n') out.delete(out.length() - 1, out.length());
        return out;
    }

    private static void appendInline(SpannableStringBuilder out, String line) {
        // bold first, then inline code, on the plain text (no markup is ever interpreted as HTML)
        Matcher m = BOLD.matcher(line);
        int last = 0;
        while (m.find()) {
            appendCode(out, line.substring(last, m.start()));
            int s = out.length();
            appendCode(out, m.group(1));
            out.setSpan(new StyleSpan(Typeface.BOLD), s, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            last = m.end();
        }
        appendCode(out, line.substring(last));
    }

    private static void appendCode(SpannableStringBuilder out, String text) {
        Matcher m = CODE.matcher(text);
        int last = 0;
        while (m.find()) {
            out.append(text, last, m.start());
            int s = out.length();
            out.append(m.group(1));
            out.setSpan(new TypefaceSpan("monospace"), s, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            out.setSpan(new BackgroundColorSpan(Color.parseColor("#15274A")), s, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            last = m.end();
        }
        out.append(text.substring(last));
    }
}
