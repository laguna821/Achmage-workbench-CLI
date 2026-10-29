/*
 * GTK 3 module for the app-e2e harness (loaded through GTK_MODULES, built at run time).
 * On the Broadway backend GTK never sets a screen resolution (only X11's XSETTINGS or an app does),
 * so gdk_screen_get_resolution() stays -1 and WebKitGTK lays the page out at a zoom of -1/96
 * (innerWidth -122880). This sets 96 dpi, as a desktop session would, and changes nothing else.
 */
#include <gtk/gtk.h>

static void apply(GdkDisplay *display) {
  GdkScreen *screen = gdk_display_get_default_screen(display);
  if (screen && gdk_screen_get_resolution(screen) <= 0) gdk_screen_set_resolution(screen, 96.0);
}

static void opened(GdkDisplayManager *manager, GdkDisplay *display, gpointer data) {
  (void)manager;
  (void)data;
  apply(display);
}

G_MODULE_EXPORT void gtk_module_init(gint *argc, gchar ***argv) {
  (void)argc;
  (void)argv;
  GdkDisplay *display = gdk_display_get_default();
  if (display) apply(display);
  g_signal_connect(gdk_display_manager_get(), "display-opened", G_CALLBACK(opened), NULL);
}
