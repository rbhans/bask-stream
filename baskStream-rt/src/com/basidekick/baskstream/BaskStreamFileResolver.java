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
    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("path", body);
    result.put("size", Long.valueOf(bytes.length));
    result.put("created", Boolean.valueOf(existing == null));
    if (dryRun)
    {
      result.put("dryRun", Boolean.TRUE);
      return result;
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
    audit("file_write", body, bytes.length + " bytes", context);
    return result;
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
