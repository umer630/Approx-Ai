package com.approxtech.ai;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Android system notifications for Approx: new in-app notifications (tasks, security, model switches) and available
 * updates, shown while Approx is running (there is no push service yet, so nothing arrives while the app is closed).
 * Opt-in: Settings → Notifications → Phone notifications; on Android 13+ the system permission is asked then.
 * "On" is only reported when Android itself says notifications are enabled.
 */
final class Notifier {
    static final String CH_ACTIVITY = "approx_activity", CH_UPDATES = "approx_updates";
    static final int REQ_NOTIFY = 7311;

    static void channels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.createNotificationChannel(new NotificationChannel(CH_ACTIVITY, "Approx activity", NotificationManager.IMPORTANCE_DEFAULT));
        nm.createNotificationChannel(new NotificationChannel(CH_UPDATES, "Approx updates", NotificationManager.IMPORTANCE_LOW));
    }

    /** True only when Android reports notifications enabled for Approx (and, on 13+, the permission is granted). */
    static boolean systemEnabled(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 33 && c.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED) return false;
        return nm.areNotificationsEnabled();
    }

    static void show(Context c, String channel, int id, String title, String body, String link) {
        if (!systemEnabled(c)) return;
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (link != null && !link.isEmpty()) open.putExtra("approx_link", link);
        PendingIntent pi = PendingIntent.getActivity(c, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, channel) : new Notification.Builder(c);
        b.setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle(title).setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body)).setAutoCancel(true).setContentIntent(pi);
        ((NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE)).notify(id, b.build());
    }

    /** Shows each unread server notification once (remembered by id). Called on a background thread. */
    static void syncUnread(MainActivity a, JSONObject r, SecureStore store) {
        JSONArray ns = r.optJSONArray("notifications");
        if (ns == null || !"1".equals(store.get("phone_notifications", ""))) return;
        String seen = store.get("notified_ids", "");
        StringBuilder next = new StringBuilder();
        boolean first = seen.isEmpty();   // first sync after opt-in: mark existing ones as seen, don't flood
        for (int i = 0; i < ns.length() && i < 20; i++) {
            JSONObject n = ns.optJSONObject(i);
            String id = n.optString("id");
            next.append(id).append(',');
            if (!n.isNull("read_at") || seen.contains(id + ",")) continue;
            if (!first) show(a, CH_ACTIVITY, id.hashCode(), n.optString("title"), n.optString("body"), n.optString("link"));
        }
        store.put("notified_ids", next.length() == 0 ? "," : next.toString());
    }
}
