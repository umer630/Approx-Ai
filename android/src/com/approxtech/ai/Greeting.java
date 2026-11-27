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

    /** Plain, state-based greeting: time of day + name. No invented moods or personality lines.
     *  @return {title, subtitle} */
    public static String[] of(String displayName, String email, int hour, boolean returning, long day) {
        String n = firstName(displayName, email);
        String you = n.isEmpty() ? "" : ", " + n;
        String title = hour >= 5 && hour < 12 ? "Good morning" + you : hour >= 12 && hour < 17 ? "Good afternoon" + you : "Good evening" + you;
        return new String[]{title, "How can I help you today?"};
    }

    private static String pick(int k, String... opts) { return opts[k % opts.length]; }
}
