package com.approxtech.ai;

import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Looper;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.GraphicsMode;

/** Runs the real MainActivity (compiled from android/src, resources from the built APK) headless. */
@RunWith(RobolectricTestRunner.class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@org.robolectric.annotation.Config(sdk = 33)
public class AppScreensTest {

    static List<View> all(View v, List<View> out) {
        out.add(v);
        if (v instanceof ViewGroup) { ViewGroup g = (ViewGroup) v; for (int i = 0; i < g.getChildCount(); i++) all(g.getChildAt(i), out); }
        return out;
    }
    static List<View> all(View v) { return all(v, new ArrayList<>()); }
    static TextView textView(View root, String text) {
        for (View v : all(root)) if (v instanceof TextView && !(v instanceof EditText) && text.contentEquals(((TextView) v).getText())) return (TextView) v;
        return null;
    }
    static List<String> hints(View root) {
        List<String> h = new ArrayList<>();
        for (View v : all(root)) if (v instanceof EditText && ((EditText) v).getHint() != null) h.add(((EditText) v).getHint().toString());
        return h;
    }
    static void shot(View root, String name) throws Exception {
        String dir = System.getProperty("shots");
        if (dir == null || dir.isEmpty()) return;
        root.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(2160, View.MeasureSpec.EXACTLY));
        root.layout(0, 0, 1080, 2160);
        Bitmap b = Bitmap.createBitmap(1080, 2160, Bitmap.Config.ARGB_8888);
        root.draw(new Canvas(b));
        try (FileOutputStream o = new FileOutputStream(new File(dir, name))) { b.compress(Bitmap.CompressFormat.PNG, 100, o); }
    }
    static void idle() { shadowOf(Looper.getMainLooper()).idle(); }
    static Object get(Object o, String f) throws Exception { java.lang.reflect.Field x = MainActivity.class.getDeclaredField(f); x.setAccessible(true); return x.get(o); }
    static void set(Object o, String f, Object v) throws Exception { java.lang.reflect.Field x = MainActivity.class.getDeclaredField(f); x.setAccessible(true); x.set(o, v); }

    @Test
    public void freshInstallOpensSignInDirectly_greenWhite_noServerField() throws Exception {
        ActivityController<MainActivity> c = Robolectric.buildActivity(MainActivity.class).setup();
        MainActivity a = c.get();
        idle();
        View root = a.findViewById(android.R.id.content);
        // Fresh install: straight to sign-in. No server/URL input anywhere.
        assertNotNull("Sign-in title shown", textView(root, "Welcome back"));
        List<String> h = hints(root);
        assertTrue("email + password fields: " + h, h.contains("Email") && h.contains("Password"));
        for (String x : h) assertFalse("no server/URL field: " + x, x.toLowerCase().contains("server") || x.contains("http"));
        for (View v : all(root)) if (v instanceof TextView) assertFalse("no server text on startup", ((TextView) v).getText().toString().toLowerCase().contains("server address"));
        assertEquals("API base is the production origin", "https://approx-ai.vercel.app", ((Api) get(a, "api")).getBase());
        // Theme: white background, Approx-green primary button with a pressed state, white label.
        assertEquals(0xFFFFFFFF, MainActivity.BG);
        TextView signIn = textView(root, "Sign in");
        assertNotNull("Sign in button", signIn);
        assertTrue("primary button has pressed state", signIn.getBackground() instanceof StateListDrawable);
        assertEquals("button label white on green", 0xFFFFFFFF, signIn.getCurrentTextColor());
        // Logo: transparent mark (no dark tile).
        ImageView logo = null;
        for (View v : all(root)) if (v instanceof ImageView) { logo = (ImageView) v; break; }
        assertNotNull(logo);
        assertEquals("in-app logo is the transparent mark", R.drawable.logo_mark, shadowOf(logo.getDrawable()).getCreatedFromResId());
        shot(root, "android-01-login.png");

        // Press feedback: installed on tappable views; finger down scales the button, release returns it.
        assertEquals(Boolean.TRUE, signIn.getTag(R.id.press_fx));
        long t = SystemClock.uptimeMillis();
        signIn.dispatchTouchEvent(MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, 10, 10, 0));
        shadowOf(Looper.getMainLooper()).idleFor(200, TimeUnit.MILLISECONDS);
        assertEquals("pressed → scaled down", 0.96f, signIn.getScaleX(), 0.001f);
        signIn.dispatchTouchEvent(MotionEvent.obtain(t, t + 100, MotionEvent.ACTION_CANCEL, 10, 10, 0));
        shadowOf(Looper.getMainLooper()).idleFor(300, TimeUnit.MILLISECONDS);
        assertEquals("released → back to normal", 1f, signIn.getScaleX(), 0.001f);

        // Create account screen.
        textView(root, "Create account").performClick();
        idle();
        root = a.findViewById(android.R.id.content);
        assertNotNull(textView(root, "Create your account"));
        assertTrue(hints(root).contains("Email"));
        for (String x : hints(root)) assertFalse("no server field on sign-up", x.toLowerCase().contains("server"));
        shot(root, "android-02-signup.png");
    }

    @Test
    public void chatScreen_greeting_composer() throws Exception {
        ActivityController<MainActivity> c = Robolectric.buildActivity(MainActivity.class).setup();
        MainActivity a = c.get();
        idle();
        set(a, "user", new JSONObject().put("email", "umer@example.com").put("display_name", "Umer").put("email_verified", true).put("role", "user"));
        set(a, "models", new JSONArray()
            .put(new JSONObject().put("id", "nick-4.8").put("name", "Nick 4.8").put("available", true).put("tier", "default"))
            .put(new JSONObject().put("id", "hike-6.5").put("name", "Hike 6.5").put("available", true).put("tier", "advanced"))
            .put(new JSONObject().put("id", "sona-9.0").put("name", "Sona 9.0").put("available", false).put("tier", "premium"))
            .put(new JSONObject().put("id", "fab-100x").put("name", "FAB 100x").put("available", false).put("tier", "restricted"))
            .put(new JSONObject().put("id", "fab-500x").put("name", "FAB 500X").put("available", false).put("tier", "restricted")));
        a.showChat(null);   // network refreshes run in the background; the screen is checked before they report back
        View root = a.findViewById(android.R.id.content);
        String text = "";
        for (View v : all(root)) if (v instanceof TextView) text += ((TextView) v).getText() + "\n";
        assertTrue("personal greeting: " + text, text.contains("Hi Umer — ready when you are.") || text.matches("(?s).*(Good (morning|afternoon|evening)|Morning|Welcome back|Still at it|Good to see you), Umer.*"));
        boolean prompt = false;
        for (String h : hints(root)) if (h.toLowerCase().contains("ask approx")) prompt = true;
        assertTrue("composer input present: " + hints(root), prompt);
        for (String m : new String[]{"Low", "Medium", "High"}) assertNotNull("mode " + m, textView(root, m));
        shot(root, "android-03-chat.png");
    }
}
