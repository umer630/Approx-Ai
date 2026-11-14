package com.approxtech.ai;

/**
 * Which backend the app talks to — pure logic (no Android APIs) so it is unit-tested on the JVM against the
 * URL baked into the real APK.
 *
 * Rules: the production URL baked at build time is the default. A saved override (admins / self-host only) is
 * honoured only if it was saved under the SAME baked URL; an override left over from an older build is discarded
 * (the caller also drops its session token), so installing or updating the app always reaches production.
 */
public final class ServerConfig {
    private ServerConfig() {}

    /** @return {server, discardOverride ("1"/"0")} — server is never a web route, only an https origin. */
    public static String[] resolve(String baked, String override, String overrideSavedForBaked) {
        String b = baked == null ? "" : baked.trim();
        String o = override == null ? "" : override.trim();
        boolean discard = o.length() > 0 && !b.equals(overrideSavedForBaked == null ? "" : overrideSavedForBaked);
        if (discard) o = "";
        String chosen = o.length() > 0 ? o : b;
        try { chosen = chosen.isEmpty() ? "" : Api.normalizeServer(chosen); } catch (Api.ApiException e) { chosen = b; }
        return new String[]{chosen, discard ? "1" : "0"};
    }
}
