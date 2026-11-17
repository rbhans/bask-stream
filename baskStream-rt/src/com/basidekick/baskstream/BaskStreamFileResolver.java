package com.basidekick.baskstream;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import javax.baja.file.BFileSystem;
import javax.baja.file.BIFile;
import javax.baja.file.FilePath;
import javax.baja.sys.BAbsTime;
import javax.baja.sys.Context;

/**
 * The station's own files (Px pages, nav files, images and so on): list, read, write and delete.
 * Only the station file space, {@code ^}, is reachable. The protected station home ({@code ^^},
 * which holds config.bog and the security folder), the Niagara install and absolute paths are not.
 * Niagara's file permissions for the session's user decide the rest.
 */
final class BaskStreamFileResolver
{
  static final int MAX_READ_BYTES = 4 * 1024 * 1024;
  static final int MAX_ENTRIES = 2000;
  static final int MAX_DELETE_ENTRIES = 500;

  private final BBaskStreamService service;

  BaskStreamFileResolver(BBaskStreamService service)
  {
    this.service = service;
  }

  Map<String, Object> list(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    String body = body(request.get("path") == null ? "^" : request.get("path"));
    FilePath path = path(body);
    requireRead(path, context);
    BIFile directory = find(path);
    if (directory == null)
    {
      throw new BaskStreamProtocolException("file_not_found", "No such folder: " + body);
    }
    if (!directory.isDirectory())
    {
      throw new BaskStreamProtocolException("bad_request", body + " is a file; use read_file.");
    }
    List<Object> entries = new ArrayList<Object>();
    boolean truncated = false;
    for (BIFile child : children(directory))
    {
      if (entries.size() >= MAX_ENTRIES) { truncated = true; break; }
      String childBody = child(body, child.getFileName());
      try
      {
        BFileSystem.INSTANCE.checkReadPermission(path(childBody), context);
      }
      catch (BaskStreamProtocolException | RuntimeException e)
      {
        continue;
      }
      entries.add(entry(child, childBody));
    }
    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("path", body);
    result.put("entries", entries);
    result.put("truncated", Boolean.valueOf(truncated));
    return result;
  }

  Map<String, Object> read(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    String body = body(request.get("path"));
    FilePath path = path(body);
    requireRead(path, context);
    BIFile file = find(path);
    if (file == null)
    {
      throw new BaskStreamProtocolException("file_not_found", "No such file: " + body);
    }
    if (file.isDirectory())
    {
      throw new BaskStreamProtocolException("bad_request", body + " is a folder; use list_files.");
    }
    int max = BaskStreamWire.integer(request, "maxBytes", MAX_READ_BYTES, 1, MAX_READ_BYTES);
    if (file.getSize() > max)
    {
      throw new BaskStreamProtocolException("file_too_large", body + " is " + file.getSize() + " bytes; the limit is " + max + ".");
    }
    byte[] bytes;
    try
    {
      bytes = file.read();
    }
    catch (IOException | RuntimeException e)
    {
      throw failed("read", body, e);
    }
    if (bytes.length > max)
    {
      throw new BaskStreamProtocolException("file_too_large", body + " is " + bytes.length + " bytes; the limit is " + max + ".");
    }
    Map<String, Object> result = entry(file, body);
    String encoding = BaskStreamWire.string(request, "encoding");
    if (encoding != null && !"text".equals(encoding) && !"base64".equals(encoding))
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'encoding' must be \"text\" or \"base64\".");
    }
    String text = "base64".equals(encoding) ? null : utf8(bytes);
    if (text == null && "text".equals(encoding))
    {
      throw new BaskStreamProtocolException("bad_request", body + " is not UTF-8 text; read it with encoding: \"base64\".");
    }
    if (text != null)
    {
      result.put("encoding", "text");
      result.put("text", text);
    }
    else
    {
      result.put("encoding", "base64");
      result.put("base64", Base64.getEncoder().encodeToString(bytes));
    }
    return result;
  }

  Map<String, Object> write(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    String body = body(request.get("path"));
    FilePath path = path(body);
    if (path.depth() == 0)
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'path' must name a file.");
    }
    Object text = request.get("text");
    Object base64 = request.get("base64");
    if ((text instanceof String) == (base64 instanceof String))
    {
      throw new BaskStreamProtocolException("bad_request", "Send the content as exactly one of 'text' or 'base64'.");
    }
    byte[] bytes;
    try
    {
      bytes = text instanceof String ? ((String) text).getBytes(StandardCharsets.UTF_8) : Base64.getDecoder().decode((String) base64);
    }
    catch (IllegalArgumentException e)
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'base64' is not valid base64.");
    }
    requireWrite(path, context);
    BIFile existing = find(path);
    boolean dryRun = Boolean.TRUE.equals(request.get("dryRun"));
    if (existing != null)
    {
      if (existing.isDirectory())
      {
        throw new BaskStreamProtocolException("bad_request", body + " is a folder.");
      }
      if (!Boolean.TRUE.equals(request.get("overwrite")))
      {
        throw new BaskStreamProtocolException("file_exists", body + " already exists; send overwrite: true to replace it.");
      }
      if (existing.isReadonly())
      {
        throw new BaskStreamProtocolException("forbidden_file", body + " is read-only.");
      }
    }
    Object backupValue = request.get("backup");
    if (backupValue != null && !(backupValue instanceof Boolean))
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'backup' must be a boolean.");
    }
    String backup = existing != null && (backupValue == null ? backsUpByDefault(body) : ((Boolean) backupValue).booleanValue())
        && !body.startsWith(BACKUP_ROOT + "/") ? backupPath(body) : null;
    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("path", body);
    result.put("size", Long.valueOf(bytes.length));
    result.put("created", Boolean.valueOf(existing == null));
    if (backup != null) result.put("backup", backup);
    if (dryRun)
    {
      result.put("dryRun", Boolean.TRUE);
      return result;
    }
    if (backup != null)
    {
      // The old content is kept before anything is replaced; when it cannot be kept, nothing is replaced.
      FilePath backupFile = path(backup);
      try
      {
        byte[] old = existing.read();
        service.requireWritesEnabled();
        requireWrite(backupFile, context);
        makeParents(backupFile, true, context);
        BFileSystem.INSTANCE.makeFile(backupFile, context).write(old);
      }
      catch (IOException | RuntimeException e)
      {
        throw new BaskStreamProtocolException("file_failed", "Could not back up " + body + " to " + backup
            + " before replacing it, so it was not replaced: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage())
            + ". Send backup: false to replace it without a copy.");
      }
    }
    try
    {
      service.requireWritesEnabled();
      if (existing == null)
      {
        makeParents(path, !Boolean.FALSE.equals(request.get("createDirs")), context);
        existing = BFileSystem.INSTANCE.makeFile(path, context);
      }
      existing.write(bytes);
    }
    catch (IOException | RuntimeException e)
    {
      throw failed("write", body, e);
    }
    audit("file_write", body, bytes.length + " bytes" + (backup == null ? "" : ", old content kept at " + backup), context);
    return result;
  }

  /** Where replaced files are kept: one folder per write, named by the station's local time. */
  static final String BACKUP_ROOT = "^bask/backups";

  /** Graphics files (Px, nav, images) are copied before they are replaced unless the request says not to. */
  static boolean backsUpByDefault(String body)
  {
    String lower = body.toLowerCase(java.util.Locale.ROOT);
    for (String ext : new String[] { ".px", ".nav", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".bmp" })
    {
      if (lower.endsWith(ext)) return true;
    }
    return false;
  }

  private static String backupPath(String body) throws BaskStreamProtocolException
  {
    String stamp = java.time.format.DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss-SSS")
        .format(java.time.LocalDateTime.now());
    String candidate = BACKUP_ROOT + "/" + stamp + "/" + body.substring(1);
    for (int n = 2; find(path(candidate)) != null && n < 100; n++)
    {
      candidate = BACKUP_ROOT + "/" + stamp + "-" + n + "/" + body.substring(1);
    }
    return candidate;
  }

  // ---- For the graphics operations ---------------------------------------------------------------

  /** A file's bytes, checked as read_file checks them. */
  byte[] readBytes(Object rawPath, Context context) throws BaskStreamProtocolException
  {
    String body = body(rawPath);
    FilePath path = path(body);
    requireRead(path, context);
    BIFile file = find(path);
    if (file == null) throw new BaskStreamProtocolException("file_not_found", "No such file: " + body);
    if (file.isDirectory()) throw new BaskStreamProtocolException("bad_request", body + " is a folder.");
    if (file.getSize() > MAX_READ_BYTES)
    {
      throw new BaskStreamProtocolException("file_too_large", body + " is " + file.getSize() + " bytes; the limit is " + MAX_READ_BYTES + ".");
    }
    try
    {
      return file.read();
    }
    catch (IOException | RuntimeException e)
    {
      throw failed("read", body, e);
    }
  }

  /**
   * Whether a file ORD such as {@code file:^px/Home.px} names a file the user can read: "ok",
   * "missing", "forbidden", or "not_checked" for anything outside the station file space.
   */
  String status(String fileOrd, Context context)
  {
    String body;
    FilePath path;
    try
    {
      body = body(fileOrd);
      path = path(body);
    }
    catch (BaskStreamProtocolException e)
    {
      return "not_checked";
    }
    try
    {
      BFileSystem.INSTANCE.checkReadPermission(path, context);
    }
    catch (RuntimeException e)
    {
      return "forbidden";
    }
    BIFile file = find(path);
    return file == null || file.isDirectory() ? "missing" : "ok";
  }

  /** Station files under a folder whose names end with one of the extensions, depth first, readable only. */
  List<Map<String, Object>> scan(String rootBody, Set<String> extensions, int max, Set<String> skip, Context context, boolean[] truncated)
      throws BaskStreamProtocolException
  {
    List<Map<String, Object>> found = new ArrayList<Map<String, Object>>();
    String start = body(rootBody);
    BIFile root = find(path(start));
    if (root == null || !root.isDirectory()) return found;
    scan(root, start, extensions, max, skip, context, found, truncated, 0);
    return found;
  }

  private void scan(BIFile folder, String body, Set<String> extensions, int max, Set<String> skip, Context context,
      List<Map<String, Object>> found, boolean[] truncated, int depth) throws BaskStreamProtocolException
  {
    if (depth > 16) return;
    for (BIFile child : children(folder))
    {
      if (found.size() >= max)
      {
        truncated[0] = true;
        return;
      }
      String childBody = child(body, child.getFileName());
      if (skip.contains(childBody)) continue;
      try
      {
        BFileSystem.INSTANCE.checkReadPermission(path(childBody), context);
      }
      catch (BaskStreamProtocolException | RuntimeException e)
      {
        continue;
      }
      if (child.isDirectory())
      {
        scan(child, childBody, extensions, max, skip, context, found, truncated, depth + 1);
        continue;
      }
      String lower = child.getFileName().toLowerCase(java.util.Locale.ROOT);
      int dot = lower.lastIndexOf('.');
      if (dot >= 0 && extensions.contains(lower.substring(dot + 1))) found.add(entry(child, childBody));
    }
  }

  Map<String, Object> delete(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    String body = body(request.get("path"));
    FilePath path = path(body);
    if (path.depth() == 0)
    {
      throw new BaskStreamProtocolException("bad_request", "The station file root cannot be deleted.");
    }
    requireWrite(path, context);
    BIFile file = find(path);
    if (file == null)
    {
      throw new BaskStreamProtocolException("file_not_found", "No such file or folder: " + body);
    }
    List<String> doomed = new ArrayList<String>();
    collect(file, body, Boolean.TRUE.equals(request.get("recursive")), doomed, context);
    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("path", body);
    result.put("deleted", doomed);
    if (Boolean.TRUE.equals(request.get("dryRun")))
    {
      result.put("dryRun", Boolean.TRUE);
      return result;
    }
    try
    {
      // Children were collected before their folders, so deleting in reverse empties each folder first.
      for (int i = doomed.size() - 1; i >= 0; i--)
      {
        service.requireWritesEnabled();
        BFileSystem.INSTANCE.delete(path(doomed.get(i)), context);
      }
    }
    catch (IOException | RuntimeException e)
    {
      throw failed("delete", body, e);
    }
    audit("file_delete", body, doomed.size() + " entries", context);
    return result;
  }

  /** The file or folder, then everything under it. A folder with children needs recursive: true. */
  private void collect(BIFile file, String body, boolean recursive, List<String> doomed, Context context)
      throws BaskStreamProtocolException
  {
    if (doomed.size() >= MAX_DELETE_ENTRIES)
    {
      throw new BaskStreamProtocolException("bad_request", "More than " + MAX_DELETE_ENTRIES + " files; delete a smaller folder.");
    }
    doomed.add(body);
    if (!file.isDirectory()) return;
    BIFile[] children = children(file);
    if (children.length > 0 && !recursive)
    {
      throw new BaskStreamProtocolException("bad_request", body + " is not empty; send recursive: true to delete it and its contents.");
    }
    for (BIFile child : children)
    {
      String childBody = child(body, child.getFileName());
      requireWrite(path(childBody), context);
      collect(child, childBody, true, doomed, context);
    }
  }

  private void makeParents(FilePath path, boolean create, Context context) throws BaskStreamProtocolException, IOException
  {
    String[] names = path.getNames();
    String body = "^";
    for (int i = 0; i < names.length - 1; i++)
    {
      body = child(body, names[i]);
      FilePath folder = path(body);
      BIFile existing = find(folder);
      if (existing == null)
      {
        if (!create)
        {
          throw new BaskStreamProtocolException("file_not_found", "No such folder: " + body);
        }
        BFileSystem.INSTANCE.makeDir(folder, context);
      }
      else if (!existing.isDirectory())
      {
        throw new BaskStreamProtocolException("bad_request", body + " is a file, not a folder.");
      }
    }
  }

  /** The path a request names, in the one form every file check uses (^px/Home.px). */
  static String canonical(Object raw) throws BaskStreamProtocolException
  {
    return body(raw);
  }

  /** The path as text after the file: scheme, e.g. ^px/Home.px. Only the station file space is accepted. */
  private static String body(Object raw) throws BaskStreamProtocolException
  {
    if (!(raw instanceof String) || ((String) raw).trim().length() == 0)
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'path' is required, e.g. ^px/Home.px.");
    }
    String text = ((String) raw).trim();
    if (text.startsWith("file:")) text = text.substring(5);
    while (text.length() > 1 && text.endsWith("/")) text = text.substring(0, text.length() - 1);
    if (!text.startsWith("^") || text.startsWith("^^") || text.indexOf("..") >= 0 || text.indexOf('|') >= 0
        || text.indexOf('\\') >= 0 || text.indexOf(':') >= 0 || text.indexOf('!') >= 0 || text.indexOf("//") >= 0
        || text.startsWith("^/"))
    {
      throw new BaskStreamProtocolException("forbidden_file",
          "Only the station file space is reachable: paths start with ^ (e.g. ^px/Home.px) and cannot contain '..'.");
    }
    return text;
  }

  private static FilePath path(String body) throws BaskStreamProtocolException
  {
    FilePath path;
    try
    {
      path = new FilePath(body);
    }
    catch (RuntimeException e)
    {
      throw new BaskStreamProtocolException("bad_request", "Not a valid file path: " + body);
    }
    if (!path.isStationHomeAbsolute() || path.getBackupDepth() != 0)
    {
      throw new BaskStreamProtocolException("forbidden_file", "Only the station file space (^) is reachable.");
    }
    return path;
  }

  private static String child(String parent, String name)
  {
    return "^".equals(parent) ? parent + name : parent + "/" + name;
  }

  private static BIFile find(FilePath path)
  {
    try
    {
      return BFileSystem.INSTANCE.findFile(path);
    }
    catch (RuntimeException e)
    {
      return null;
    }
  }

  private static BIFile[] children(BIFile directory)
  {
    BIFile[] children = BFileSystem.INSTANCE.getChildren(directory);
    return children == null ? new BIFile[0] : children;
  }

  private static void requireRead(FilePath path, Context context) throws BaskStreamProtocolException
  {
    try
    {
      BFileSystem.INSTANCE.checkReadPermission(path, context);
    }
    catch (RuntimeException e)
    {
      throw new BaskStreamProtocolException("forbidden_file", "The authenticated user may not read this path.");
    }
  }

  private static void requireWrite(FilePath path, Context context) throws BaskStreamProtocolException
  {
    try
    {
      BFileSystem.INSTANCE.checkWritePermission(path, context);
    }
    catch (RuntimeException e)
    {
      throw new BaskStreamProtocolException("forbidden_file", "The authenticated user may not write this path.");
    }
  }

  private static Map<String, Object> entry(BIFile file, String body)
  {
    Map<String, Object> entry = new LinkedHashMap<String, Object>();
    entry.put("path", body);
    entry.put("name", file.getFileName());
    entry.put("directory", Boolean.valueOf(file.isDirectory()));
    if (!file.isDirectory()) entry.put("size", Long.valueOf(file.getSize()));
    BAbsTime modified = file.getLastModified();
    entry.put("modified", modified == null || modified.isNull() ? null : Long.valueOf(modified.getMillis()));
    entry.put("readonly", Boolean.valueOf(file.isReadonly()));
    return entry;
  }

  /** The bytes as text when they are valid UTF-8, else null. */
  private static String utf8(byte[] bytes)
  {
    try
    {
      return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
    }
    catch (CharacterCodingException e)
    {
      return null;
    }
  }

  private static BaskStreamProtocolException failed(String what, String body, Exception e)
  {
    if (e instanceof BaskStreamProtocolException) return (BaskStreamProtocolException) e;
    return new BaskStreamProtocolException("file_failed", "Could not " + what + " " + body + ": "
        + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
  }

  private void audit(String event, String body, String detail, Context context)
  {
    String user = context == null || context.getUser() == null ? null : context.getUser().getUsername();
    service.audit(event, "user=" + user + " path=" + body + " " + detail);
    try
    {
      javax.baja.security.Auditor auditor = javax.baja.sys.Sys.getAuditor();
      if (auditor != null)
      {
        auditor.audit(new javax.baja.security.AuditEvent(event, "file:" + body, null, null, detail, user));
      }
    }
    catch (RuntimeException e)
    {
      service.LOG.log(java.util.logging.Level.WARNING, "baskStream could not record a file audit event", e);
    }
  }
}
