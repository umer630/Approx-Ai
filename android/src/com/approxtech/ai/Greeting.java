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

    /** Time of day → greeting: morning 5–12, afternoon 12–17, evening 17–21, night 21–24, "Night owl?" 0–5.
     *  @return {title, subtitle} */
    public static String[] of(String displayName, String email, int hour, boolean returning, long day) {
        String n = firstName(displayName, email);
        String you = n.isEmpty() ? "" : ", " + n;
        int k = (int) Math.abs(day);
        String title;
        if (hour >= 5 && hour < 12) title = "Good morning" + you;
        else if (hour >= 12 && hour < 17) title = "Good afternoon" + you;
        else if (hour >= 17 && hour < 21) title = "Good evening" + you;
        else if (hour >= 21) title = "Good night" + you;
        else title = "Night owl" + you + "?";
        String subtitle = !returning ? "Welcome to Approx AI. What would you like to do?"
                : pick(k, "How are you today" + you + "?", "What can I help you with today?", "What are we working on today?");
        return new String[]{title, subtitle};
    }

    private static String pick(int k, String... opts) { return opts[k % opts.length]; }
}
