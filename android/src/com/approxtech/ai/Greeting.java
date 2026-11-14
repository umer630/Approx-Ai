package com.approxtech.ai;

/**
 * Approx's welcome line for an empty chat — warm, brief, professional. Mirrors web/js/greeting.js.
 * Pure Java (no Android APIs) so it is unit-tested on the JVM.
 */
public final class Greeting {
    private Greeting() {}

    /** A first name to greet by: the display name, or a name-like email local part ("umer.khan" → "Umer"). */
    public static String firstName(String displayName, String email) {
        String d = displayName == null ? "" : displayName.trim();
        if (d.length() > 0) { String f = d.split("\\s+")[0]; return cap(f.length() > 24 ? f.substring(0, 24) : f); }
        String local = email == null ? "" : email.split("@")[0].split("[._+-]")[0];
        // Only letters, 2–20 long: "umer" yes, "uq866108" no — a random handle is worse than no name.
        return local.matches("^\\p{L}{2,20}$") ? cap(local) : "";
    }

    private static String cap(String s) { return s.isEmpty() ? s : s.substring(0, 1).toUpperCase() + s.substring(1); }

    /** @return {title, subtitle} */
    public static String[] of(String displayName, String email, int hour, boolean returning, long day) {
        String n = firstName(displayName, email);
        String you = n.isEmpty() ? "" : ", " + n;
        int k = (int) Math.abs(day);
        String title;
        if (!returning) title = n.isEmpty() ? "Hi — ready when you are." : "Hi " + n + " — ready when you are.";
        else if (hour >= 5 && hour < 12) title = pick(k, "Good morning" + you + ".", "Morning" + you + ". Good to see you.");
        else if (hour >= 12 && hour < 17) title = pick(k, "Good afternoon" + you + ".", "Good to see you" + you + ".");
        else if (hour >= 17 && hour < 22) title = pick(k, "Good evening" + you + ".", "Welcome back" + you + ".");
        else title = pick(k, "Still at it" + you + "?", "Welcome back" + you + ".");
        String subtitle = !returning ? "What would you like to work on?"
                : pick(k, "What are we working on today?", "What can I help you with today?", "What’s on your mind?");
        return new String[]{title, subtitle};
    }

    private static String pick(int k, String... opts) { return opts[k % opts.length]; }
}
