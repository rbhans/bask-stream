package com.basidekick.baskstream;

import java.io.ByteArrayOutputStream;
import java.util.Base64;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Files sent in pieces, for content larger than one message. The pieces are held in memory for one
 * session until {@code commit_upload} turns them into an ordinary {@code write_file}, so the file
 * rules, the backup and the audit record are the ones every file write gets. Nothing on the station
 * changes before the commit.
 */
final class BaskStreamUploads
{
  /** The largest file that can be sent in pieces. */
  static final int MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
  /** Uploads one session may have open. */
  static final int MAX_OPEN = 2;
  /** An upload nothing has been added to for this long is dropped. */
  static final long IDLE_MILLIS = 5 * 60 * 1000L;

  private static final class Upload
  {
    String path;
    long touched;
    final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
  }

  private final Map<String, Upload> open = new LinkedHashMap<String, Upload>();

  synchronized Map<String, Object> begin(String path, long now) throws BaskStreamProtocolException
  {
    expire(now);
    if (open.size() >= MAX_OPEN)
      throw new BaskStreamProtocolException("upload_limit", "This session already has " + MAX_OPEN + " uploads open. Commit one, or wait for it to lapse.");
    Upload upload = new Upload();
    upload.path = path;
    upload.touched = now;
    String id = UUID.randomUUID().toString();
    open.put(id, upload);
    Map<String, Object> wire = new LinkedHashMap<String, Object>();
    wire.put("upload", id);
    wire.put("path", path);
    wire.put("maxBytes", Long.valueOf(MAX_UPLOAD_BYTES));
    wire.put("expiresAt", Long.valueOf(now + IDLE_MILLIS));
    return wire;
  }

  synchronized Map<String, Object> append(Map<String, Object> request, long now) throws BaskStreamProtocolException
  {
    expire(now);
    Upload upload = find(request);
    Object data = request.get("bytes");
    byte[] piece;
    if (data instanceof byte[]) piece = (byte[])data;
    else if (request.get("base64") instanceof String)
    {
      try
      {
        piece = Base64.getDecoder().decode((String)request.get("base64"));
      }
      catch (IllegalArgumentException e)
      {
        throw new BaskStreamProtocolException("bad_request", "Field 'base64' is not valid base64.");
      }
    }
    else throw new BaskStreamProtocolException("bad_request", "Send the piece as 'bytes' (binary) or 'base64'.");
    if (upload.bytes.size() + piece.length > MAX_UPLOAD_BYTES)
      throw new BaskStreamProtocolException("file_too_large", "An upload can hold " + MAX_UPLOAD_BYTES + " bytes at most.");
    upload.bytes.write(piece, 0, piece.length);
    upload.touched = now;
    Map<String, Object> wire = new LinkedHashMap<String, Object>();
    wire.put("upload", request.get("upload"));
    wire.put("received", Long.valueOf(upload.bytes.size()));
    wire.put("expiresAt", Long.valueOf(now + IDLE_MILLIS));
    return wire;
  }

  /**
   * Closes an upload and returns the {@code write_file} request it stands for: the commit's own
   * fields (overwrite, backup, reason...) with the upload's path and content.
   */
  synchronized Map<String, Object> commit(Map<String, Object> request, long now) throws BaskStreamProtocolException
  {
    expire(now);
    Upload upload = find(request);
    Object size = request.get("size");
    if (size instanceof Number && ((Number)size).longValue() != upload.bytes.size())
      throw new BaskStreamProtocolException("upload_incomplete", "The upload holds " + upload.bytes.size() + " bytes, not the " + size + " the commit expects. It is still open.");
    open.remove(String.valueOf(request.get("upload")));
    Map<String, Object> write = new LinkedHashMap<String, Object>(request);
    write.remove("upload");
    write.remove("size");
    write.remove("text");
    write.remove("base64");
    write.put("path", upload.path);
    write.put("bytes", upload.bytes.toByteArray());
    return write;
  }

  synchronized void clear()
  {
    open.clear();
  }

  private Upload find(Map<String, Object> request) throws BaskStreamProtocolException
  {
    Object id = request.get("upload");
    Upload upload = id instanceof String ? open.get(id) : null;
    if (upload == null)
      throw new BaskStreamProtocolException("upload_not_found", "No such upload in this session. It may have lapsed after " + (IDLE_MILLIS / 60000L) + " minutes without a piece; begin again.");
    return upload;
  }

  private void expire(long now)
  {
    Iterator<Upload> it = open.values().iterator();
    while (it.hasNext())
      if (now - it.next().touched > IDLE_MILLIS) it.remove();
  }
}
