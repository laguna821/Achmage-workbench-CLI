/*
 * GTK 3 module for the app-e2e harness (loaded through GTK_MODULES, built at run time).
 * On the Broadway backend GTK never sets a screen resolution (only X11's XSETTINGS or an app does),
 * so gdk_screen_get_resolution() stays -1 and WebKitGTK lays the page out at a zoom of -1/96
 * (innerWidth -122880). This sets 96 dpi, as a desktop session would.
 * When explicitly requested, also captures the real GTK print dialog and presses Cancel.
 * WebDriver controls web content and cannot dismiss a GTK modal. No print result is faked.
 */
#include <gtk/gtk.h>

static gboolean cancel_print(gpointer data) {
  GtkWidget *dialog = GTK_WIDGET(data);
  const char *dir = g_getenv("APP_E2E_PRINT_PROBE_DIR");
  if (dir && gtk_widget_get_visible(dialog)) {
    int width = gtk_widget_get_allocated_width(dialog), height = gtk_widget_get_allocated_height(dialog);
    cairo_surface_t *surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, width, height);
    cairo_t *cr = cairo_create(surface);
    gtk_widget_draw(dialog, cr);
    char *png = g_build_filename(dir, "native-print-dialog.png", NULL);
    cairo_status_t status = cairo_surface_write_to_png(surface, png);
    cairo_destroy(cr); cairo_surface_destroy(surface); g_free(png);
    char *record = g_strdup_printf("type=%s\nvisible=1\nwidth=%d\nheight=%d\nscreenshot=%s\nresponse=cancel\n", G_OBJECT_TYPE_NAME(dialog), width, height, cairo_status_to_string(status));
    char *path = g_build_filename(dir, "native-print-dialog.txt", NULL);
    g_file_set_contents(path, record, -1, NULL); g_free(path); g_free(record);
    gtk_dialog_response(GTK_DIALOG(dialog), GTK_RESPONSE_CANCEL);
  }
  g_object_unref(dialog);
  return G_SOURCE_REMOVE;
}

static gboolean watch_print(gpointer data) {
  (void)data;
  GList *windows = gtk_window_list_toplevels();
  for (GList *it = windows; it; it = it->next) {
    GtkWidget *window = GTK_WIDGET(it->data);
    if (g_strcmp0(G_OBJECT_TYPE_NAME(window), "GtkPrintUnixDialog") == 0 && gtk_widget_get_visible(window) && !g_object_get_data(G_OBJECT(window), "wb-print-seen")) {
      g_object_set_data(G_OBJECT(window), "wb-print-seen", GINT_TO_POINTER(1));
      g_timeout_add(750, cancel_print, g_object_ref(window));
    }
  }
  g_list_free(windows);
  return G_SOURCE_CONTINUE;
}

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
  if (g_getenv("APP_E2E_PRINT_PROBE_DIR")) g_timeout_add(100, watch_print, NULL);
}
