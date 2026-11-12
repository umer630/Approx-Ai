package com.approxtech.ai;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * On-device command engine for the standalone Approx AI app. NO network, NO server, NO large model.
 * Every answer here is COMPUTED by deterministic logic (the same kind of verified computation used to generate
 * the training curriculum), so it is correct by construction — not produced by a language model.
 *
 * It honestly reports what it cannot do: open-ended conversation needs a language model, which cannot run inside
 * an APK, so for those queries it returns a clear "not available offline" answer instead of inventing one.
 */
public final class OfflineBrain {

    public static final class Reply {
        public final String text;
        public final boolean handled;   // true = answered on-device; false = outside offline scope
        Reply(String text, boolean handled) { this.text = text; this.handled = handled; }
    }

    private OfflineBrain() {}

    public static Reply answer(String raw) {
        if (raw == null) return new Reply("Please type or say something.", true);
        String q = raw.trim();
        if (q.isEmpty()) return new Reply("Please type or say something.", true);
        String l = q.toLowerCase(Locale.ROOT).trim();

        // identity / help / greetings
        if (l.matches("(hi|hello|hey|salam|assalam.*|aoa)\\b.*")) return new Reply("Hello! I'm the Approx AI offline assistant. I can do maths, conversions, geometry, dates and a few facts — right here on your phone, no internet. Try \"15% of 240\" or \"solve 3x+7=22\".", true);
        if (l.contains("who are you") || l.contains("what are you") || l.contains("tum kaun") || l.contains("aap kaun")) return new Reply("I'm the Approx AI offline assistant by Approx Technology. I run fully on your device with no server. I handle calculations, unit conversions, geometry, dates and some built-in facts. Full conversational AI (Nick 4.8) needs the language model, which is not bundled in this offline build.", true);
        if (l.equals("help") || l.contains("what can you do") || l.contains("kya kar sakte")) return new Reply(help(), true);
        if (l.contains("thank")) return new Reply("You're welcome!", true);

        // date / time
        if (l.contains("date") || l.contains("today") || l.contains("aaj")) {
            if (l.contains("time")) return new Reply("It is " + fmt("EEEE, d MMMM yyyy, h:mm a") + ".", true);
            return new Reply("Today is " + fmt("EEEE, d MMMM yyyy") + ".", true);
        }
        if (l.contains("time") && (l.contains("what") || l.contains("current") || l.contains("kya"))) return new Reply("The time is " + fmt("h:mm a") + ".", true);
        if (l.contains("day") && (l.contains("what") || l.contains("which") || l.contains("today"))) return new Reply("Today is " + fmt("EEEE") + ".", true);

        Reply r;
        if ((r = percent(l)) != null) return r;
        if ((r = algebra(l)) != null) return r;
        if ((r = geometry(l)) != null) return r;
        if ((r = conversion(l)) != null) return r;
        if ((r = roots(l)) != null) return r;
        if ((r = facts(l)) != null) return r;
        if ((r = arithmetic(l)) != null) return r;

        // honest fallback — never invent a conversational answer
        return new Reply("I can't answer that in offline mode — open-ended conversation needs the Approx AI language model, which can't run inside the app.\n\nWhat I CAN do on-device: " + help(), false);
    }

    private static String help() {
        return "arithmetic (e.g. 23 + 45, 12 × 8), percentages (15% of 240), algebra (solve 3x + 7 = 22), "
             + "square roots (sqrt 169), unit & temperature conversion (5 km to m, 30 C to F, 2 hours to minutes), "
             + "geometry (area of a rectangle 5 by 3, area of a circle radius 4, pythagoras 3 4), dates and times, "
             + "and a few built-in facts (e.g. capital of Pakistan).";
    }

    private static String fmt(String pattern) { return new SimpleDateFormat(pattern, Locale.ENGLISH).format(new Date()); }

    private static String num(double d) {
        if (Math.abs(d - Math.rint(d)) < 1e-9) return String.valueOf((long) Math.rint(d));
        return String.valueOf(Math.round(d * 1e6) / 1e6);
    }

    // ---- percentages: "15% of 240", "what is 15 percent of 240"
    private static Reply percent(String l) {
        Matcher m = Pattern.compile("(-?\\d+(?:\\.\\d+)?)\\s*(?:%|percent)\\s*of\\s*(-?\\d+(?:\\.\\d+)?)").matcher(l);
        if (m.find()) {
            double p = Double.parseDouble(m.group(1)), x = Double.parseDouble(m.group(2));
            double res = p / 100 * x;
            return new Reply(num(p) + "% of " + num(x) + " = " + num(p) + "/100 × " + num(x) + " = " + num(res) + ".", true);
        }
        return null;
    }

    // ---- linear algebra: "solve 3x + 7 = 22"
    private static Reply algebra(String l) {
        Matcher m = Pattern.compile("(-?\\d*)\\s*x\\s*([+-]\\s*\\d+(?:\\.\\d+)?)?\\s*=\\s*(-?\\d+(?:\\.\\d+)?)").matcher(l.replace(" ", ""));
        // re-match on a despaced copy
        String s = l.replaceAll("\\s+", "");
        m = Pattern.compile("(-?\\d*)x([+-]\\d+(?:\\.\\d+)?)?=(-?\\d+(?:\\.\\d+)?)").matcher(s);
        if ((l.contains("solve") || l.contains("x")) && m.find()) {
            double a = m.group(1) == null || m.group(1).isEmpty() || m.group(1).equals("-") ? (m.group(1) != null && m.group(1).equals("-") ? -1 : 1) : Double.parseDouble(m.group(1));
            double b = m.group(2) == null ? 0 : Double.parseDouble(m.group(2));
            double c = Double.parseDouble(m.group(3));
            if (a == 0) return new Reply("That is not a solvable linear equation in x (coefficient of x is 0).", true);
            double x = (c - b) / a;
            return new Reply("Solve " + m.group(0).replace("*", "") + ":\n" + (b != 0 ? (b > 0 ? "Subtract " + num(b) + " from both sides" : "Add " + num(-b) + " to both sides") + " → " + num(a) + "x = " + num(c - b) + "\n" : "")
                    + "Divide by " + num(a) + " → x = " + num(x) + ".\n\nAnswer: x = " + num(x), true);
        }
        return null;
    }

    // ---- geometry
    private static Reply geometry(String l) {
        Matcher m;
        if ((m = Pattern.compile("rectangle\\D*(\\d+(?:\\.\\d+)?)\\D+(\\d+(?:\\.\\d+)?)").matcher(l)).find()) {
            double a = Double.parseDouble(m.group(1)), b = Double.parseDouble(m.group(2));
            return new Reply("Rectangle " + num(a) + " × " + num(b) + ":\nArea = " + num(a) + " × " + num(b) + " = " + num(a * b) + "\nPerimeter = 2 × (" + num(a) + " + " + num(b) + ") = " + num(2 * (a + b)) + ".", true);
        }
        if ((m = Pattern.compile("circle\\D*(?:radius|r)\\D*(\\d+(?:\\.\\d+)?)").matcher(l)).find()) {
            double r = Double.parseDouble(m.group(1));
            return new Reply("Circle radius " + num(r) + ":\nArea = πr² ≈ 3.14159 × " + num(r * r) + " = " + num(Math.PI * r * r) + "\nCircumference = 2πr ≈ " + num(2 * Math.PI * r) + ".", true);
        }
        if ((m = Pattern.compile("triangle\\D*(\\d+(?:\\.\\d+)?)\\D+(\\d+(?:\\.\\d+)?)").matcher(l)).find() && l.contains("area")) {
            double b = Double.parseDouble(m.group(1)), h = Double.parseDouble(m.group(2));
            return new Reply("Triangle base " + num(b) + ", height " + num(h) + ":\nArea = ½ × " + num(b) + " × " + num(h) + " = " + num(b * h / 2) + ".", true);
        }
        if ((m = Pattern.compile("pythagoras\\D*(\\d+(?:\\.\\d+)?)\\D+(\\d+(?:\\.\\d+)?)").matcher(l)).find()) {
            double a = Double.parseDouble(m.group(1)), b = Double.parseDouble(m.group(2));
            double c = Math.sqrt(a * a + b * b);
            return new Reply("Pythagoras: c = √(" + num(a) + "² + " + num(b) + "²) = √" + num(a * a + b * b) + " = " + num(c) + ".", true);
        }
        return null;
    }

    // ---- unit & temperature conversion
    private static Reply conversion(String l) {
        Matcher m = Pattern.compile("(-?\\d+(?:\\.\\d+)?)\\s*(km|m|kg|g|hours?|hrs?|minutes?|mins?|c|celsius|f|fahrenheit)\\b.*\\bto\\b\\s*(km|m|kg|g|hours?|hrs?|minutes?|mins?|c|celsius|f|fahrenheit)\\b").matcher(l);
        if (m.find()) {
            double v = Double.parseDouble(m.group(1));
            String from = unit(m.group(2)), to = unit(m.group(3));
            Double out = convert(v, from, to);
            if (out != null) return new Reply(num(v) + " " + disp(from) + " = " + num(out) + " " + disp(to) + ".", true);
            return new Reply("I can convert between km/m, kg/g, hours/minutes and °C/°F, but not " + from + " → " + to + ".", true);
        }
        // "30 C to F" style with degree words
        m = Pattern.compile("(-?\\d+(?:\\.\\d+)?)\\s*(?:degrees?\\s*)?(c|celsius)\\b.*\\b(f|fahrenheit)").matcher(l);
        if (m.find()) { double c = Double.parseDouble(m.group(1)); return new Reply(num(c) + " °C = " + num(c) + " × 9/5 + 32 = " + num(c * 9 / 5 + 32) + " °F.", true); }
        m = Pattern.compile("(-?\\d+(?:\\.\\d+)?)\\s*(?:degrees?\\s*)?(f|fahrenheit)\\b.*\\b(c|celsius)").matcher(l);
        if (m.find()) { double f = Double.parseDouble(m.group(1)); return new Reply(num(f) + " °F = (" + num(f) + " − 32) × 5/9 = " + num((f - 32) * 5 / 9) + " °C.", true); }
        return null;
    }

    private static String disp(String u) { return u.equals("c") ? "\u00b0C" : u.equals("f") ? "\u00b0F" : u; }

    private static String unit(String u) {
        u = u.toLowerCase();
        if (u.startsWith("hr") || u.startsWith("hour")) return "hours";
        if (u.startsWith("min")) return "minutes";
        if (u.equals("celsius")) return "c";
        if (u.equals("fahrenheit")) return "f";
        return u;
    }

    private static Double convert(double v, String from, String to) {
        if (from.equals(to)) return v;
        if (from.equals("km") && to.equals("m")) return v * 1000;
        if (from.equals("m") && to.equals("km")) return v / 1000;
        if (from.equals("kg") && to.equals("g")) return v * 1000;
        if (from.equals("g") && to.equals("kg")) return v / 1000;
        if (from.equals("hours") && to.equals("minutes")) return v * 60;
        if (from.equals("minutes") && to.equals("hours")) return v / 60;
        if (from.equals("c") && to.equals("f")) return v * 9 / 5 + 32;
        if (from.equals("f") && to.equals("c")) return (v - 32) * 5 / 9;
        return null;
    }

    // ---- square roots
    private static Reply roots(String l) {
        Matcher m = Pattern.compile("(?:sqrt|square root of|root of)\\s*(\\d+(?:\\.\\d+)?)").matcher(l);
        if (m.find()) { double x = Double.parseDouble(m.group(1)); return new Reply("√" + num(x) + " = " + num(Math.sqrt(x)) + ".", true); }
        return null;
    }

    // ---- a small, honest built-in fact set (clearly limited; not a knowledge base)
    private static Reply facts(String l) {
        if (l.contains("capital") && l.contains("pakistan")) return new Reply("The capital of Pakistan is Islamabad.", true);
        if ((l.contains("tallest") || l.contains("highest")) && l.contains("mountain") && l.contains("pakistan")) return new Reply("The tallest mountain in Pakistan is K2 (8,611 m), in the Karakoram range.", true);
        if (l.contains("how many") && l.contains("continent")) return new Reply("There are seven continents.", true);
        if (l.contains("how many") && (l.contains("day") && l.contains("week"))) return new Reply("There are 7 days in a week.", true);
        if (l.contains("how many") && l.contains("month")) return new Reply("There are 12 months in a year.", true);
        if (l.contains("water") && (l.contains("made") || l.contains("formula") || l.contains("elements"))) return new Reply("Water is H₂O — two hydrogen atoms and one oxygen atom.", true);
        if (l.contains("speed of light")) return new Reply("The speed of light is about 299,792 km/s (3 × 10⁸ m/s).", true);
        return null;
    }

    // ---- general arithmetic expression: + - × * / and parentheses
    private static Reply arithmetic(String l) {
        String expr = l.replace("×", "*").replace("÷", "/").replace("plus", "+").replace("minus", "-")
                       .replace("times", "*").replace("multiplied by", "*").replace("divided by", "/").replace("x", "*");
        if (!expr.matches(".*\\d.*") || !expr.matches("[-+*/().\\d\\s]+")) return null;
        try {
            double v = new Expr(expr).parse();
            return new Reply(l.replaceAll("\\s+", " ").trim() + " = " + num(v) + ".", true);
        } catch (RuntimeException e) { return null; }
    }

    /** Minimal, safe recursive-descent arithmetic evaluator (no eval, no reflection). */
    private static final class Expr {
        private final String s; private int i;
        Expr(String s) { this.s = s.replaceAll("\\s+", ""); }
        double parse() { double v = expr(); if (i < s.length()) throw new RuntimeException("trailing"); return v; }
        private double expr() { double v = term(); while (i < s.length() && (s.charAt(i) == '+' || s.charAt(i) == '-')) { char op = s.charAt(i++); double t = term(); v = op == '+' ? v + t : v - t; } return v; }
        private double term() { double v = factor(); while (i < s.length() && (s.charAt(i) == '*' || s.charAt(i) == '/')) { char op = s.charAt(i++); double f = factor(); if (op == '/' && f == 0) throw new RuntimeException("div0"); v = op == '*' ? v * f : v / f; } return v; }
        private double factor() {
            if (i >= s.length()) throw new RuntimeException("eof");
            if (s.charAt(i) == '(') { i++; double v = expr(); if (i >= s.length() || s.charAt(i) != ')') throw new RuntimeException(")"); i++; return v; }
            if (s.charAt(i) == '-') { i++; return -factor(); }
            if (s.charAt(i) == '+') { i++; return factor(); }
            int j = i; while (i < s.length() && (Character.isDigit(s.charAt(i)) || s.charAt(i) == '.')) i++;
            if (j == i) throw new RuntimeException("num");
            return Double.parseDouble(s.substring(j, i));
        }
    }
}
