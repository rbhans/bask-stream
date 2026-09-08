package com.basidekick.baskstream;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class BaskStreamCodec
{
  private static final Charset UTF_8 = Charset.forName("UTF-8");
  private static final int MAX_PAYLOAD_BYTES = 1024 * 1024;
  private static final int MAX_STRING_BYTES = 64 * 1024;
  private static final int MAX_BINARY_BYTES = 64 * 1024;
  private static final int MAX_CONTAINER_SIZE = 5000;
  private static final int MAX_NESTING_DEPTH = 64;

  Map<String, Object> decodeMessage(byte[] payload) throws BaskStreamProtocolException
  {
    return decodeMessage(payload, MAX_PAYLOAD_BYTES);
  }

  Map<String, Object> decodeMessage(byte[] payload, int maxPayloadBytes) throws BaskStreamProtocolException
  {
    try
    {
      if (payload.length > maxPayloadBytes)
      {
        throw new BaskStreamProtocolException("bad_request", "MessagePack payload exceeds maximum size.");
      }
      DataInputStream input = new DataInputStream(new ByteArrayInputStream(payload));
      Object decoded = decode(input, 0);
      if (input.available() != 0)
      {
        throw new BaskStreamProtocolException("bad_request", "Trailing bytes after MessagePack message.");
      }
      if (!(decoded instanceof Map))
      {
        throw new BaskStreamProtocolException("bad_request", "Message payload must be a map.");
      }
      @SuppressWarnings("unchecked")
      Map<String, Object> result = (Map<String, Object>) decoded;
      return result;
    }
    catch (EOFException e)
    {
      throw new BaskStreamProtocolException("bad_request", "Unexpected end of MessagePack payload.");
    }
    catch (IOException e)
    {
      throw new BaskStreamProtocolException("bad_request", "Unable to decode MessagePack payload: " + e.getMessage());
    }
  }

  byte[] encodeMessage(Map<String, Object> message) throws IOException
  {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    DataOutputStream out = new DataOutputStream(bytes);
    encode(out, message);
    out.flush();
    return bytes.toByteArray();
  }

  String requireString(Map<String, Object> message, String key) throws BaskStreamProtocolException
  {
    Object value = message.get(key);
    if (!(value instanceof String))
    {
      throw new BaskStreamProtocolException("bad_request", "Field '" + key + "' must be a string.");
    }
    return (String) value;
  }

  String optionalString(Map<String, Object> message, String key)
  {
    Object value = message.get(key);
    return value instanceof String ? (String) value : null;
  }

  List<String> requireStringList(Map<String, Object> message, String key) throws BaskStreamProtocolException
  {
    Object value = message.get(key);
    if (!(value instanceof List))
    {
      throw new BaskStreamProtocolException("bad_request", "Field '" + key + "' must be an array of strings.");
    }

    List<?> values = (List<?>) value;
    List<String> result = new ArrayList<String>(values.size());
    for (Object entry : values)
    {
      if (!(entry instanceof String))
      {
        throw new BaskStreamProtocolException("bad_request", "Field '" + key + "' must be an array of strings.");
      }
      result.add((String) entry);
    }
    return result;
  }

  private Object decode(DataInputStream in, int depth) throws IOException, BaskStreamProtocolException
  {
    if (depth > MAX_NESTING_DEPTH)
    {
      throw new BaskStreamProtocolException("bad_request", "MessagePack payload is nested too deeply.");
    }

    int first = in.readUnsignedByte();

    if (first <= 0x7f)
    {
      return Long.valueOf(first);
    }
    if (first >= 0xe0)
    {
      return Long.valueOf((byte) first);
    }
    if ((first & 0xe0) == 0xa0)
    {
      return readString(in, first & 0x1f);
    }
    if ((first & 0xf0) == 0x90)
    {
      return readArray(in, first & 0x0f, depth + 1);
    }
    if ((first & 0xf0) == 0x80)
    {
      return readMap(in, first & 0x0f, depth + 1);
    }

    switch (first)
    {
      case 0xc0:
        return null;
      case 0xc2:
        return Boolean.FALSE;
      case 0xc3:
        return Boolean.TRUE;
      case 0xc4:
        return readBinary(in, in.readUnsignedByte());
      case 0xc5:
        return readBinary(in, in.readUnsignedShort());
      case 0xc6:
        return readBinary(in, safeLength(in.readInt(), MAX_BINARY_BYTES, "binary"));
      case 0xca:
        return Double.valueOf(in.readFloat());
      case 0xcb:
        return Double.valueOf(in.readDouble());
      case 0xcc:
        return Long.valueOf(in.readUnsignedByte());
      case 0xcd:
        return Long.valueOf(in.readUnsignedShort());
      case 0xce:
        return Long.valueOf(in.readInt() & 0xffffffffL);
      case 0xcf:
        long unsigned = in.readLong();
        if (unsigned < 0L)
        {
          throw new BaskStreamProtocolException("bad_request", "Unsigned integer exceeds supported range.");
        }
        return Long.valueOf(unsigned);
      case 0xd0:
        return Long.valueOf(in.readByte());
      case 0xd1:
        return Long.valueOf(in.readShort());
      case 0xd2:
        return Long.valueOf(in.readInt());
      case 0xd3:
        return Long.valueOf(in.readLong());
      case 0xd9:
        return readString(in, in.readUnsignedByte());
      case 0xda:
        return readString(in, in.readUnsignedShort());
      case 0xdb:
        return readString(in, safeLength(in.readInt(), MAX_STRING_BYTES, "string"));
      case 0xdc:
        return readArray(in, safeLength(in.readUnsignedShort(), MAX_CONTAINER_SIZE, "array"), depth + 1);
      case 0xdd:
        return readArray(in, safeLength(in.readInt(), MAX_CONTAINER_SIZE, "array"), depth + 1);
      case 0xde:
        return readMap(in, safeLength(in.readUnsignedShort(), MAX_CONTAINER_SIZE, "map"), depth + 1);
      case 0xdf:
        return readMap(in, safeLength(in.readInt(), MAX_CONTAINER_SIZE, "map"), depth + 1);
      default:
        throw new BaskStreamProtocolException("bad_request", "Unsupported MessagePack type: 0x" + Integer.toHexString(first));
    }
  }

  private byte[] readBinary(DataInputStream in, int length) throws IOException, BaskStreamProtocolException
  {
    safeLength(length, MAX_BINARY_BYTES, "binary");
    byte[] bytes = new byte[length];
    in.readFully(bytes);
    return bytes;
  }

  private List<Object> readArray(DataInputStream in, int length, int depth) throws IOException, BaskStreamProtocolException
  {
    safeLength(length, MAX_CONTAINER_SIZE, "array");
    List<Object> values = new ArrayList<Object>(length);
    for (int i = 0; i < length; i++)
    {
      values.add(decode(in, depth));
    }
    return values;
  }

  private Map<String, Object> readMap(DataInputStream in, int length, int depth) throws IOException, BaskStreamProtocolException
  {
    safeLength(length, MAX_CONTAINER_SIZE, "map");
    Map<String, Object> values = new LinkedHashMap<String, Object>(length);
    for (int i = 0; i < length; i++)
    {
      Object key = decode(in, depth);
      if (!(key instanceof String))
      {
        throw new BaskStreamProtocolException("bad_request", "MessagePack map keys must be strings.");
      }
      if (values.containsKey(key))
      {
        throw new BaskStreamProtocolException("bad_request", "Duplicate MessagePack map key: " + key);
      }
      values.put((String) key, decode(in, depth));
    }
    return values;
  }

  private String readString(DataInputStream in, int length) throws IOException, BaskStreamProtocolException
  {
    safeLength(length, MAX_STRING_BYTES, "string");
    byte[] bytes = new byte[length];
    in.readFully(bytes);
    return new String(bytes, UTF_8);
  }

  private void encode(DataOutputStream out, Object value) throws IOException
  {
    if (value == null)
    {
      out.writeByte(0xc0);
      return;
    }
    if (value instanceof String)
    {
      writeString(out, (String) value);
      return;
    }
    if (value instanceof Boolean)
    {
      out.writeByte(Boolean.TRUE.equals(value) ? 0xc3 : 0xc2);
      return;
    }
    if (value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long)
    {
      writeLong(out, ((Number) value).longValue());
      return;
    }
    if (value instanceof Float || value instanceof Double)
    {
      out.writeByte(0xcb);
      out.writeDouble(((Number) value).doubleValue());
      return;
    }
    if (value instanceof byte[])
    {
      writeBinary(out, (byte[]) value);
      return;
    }
    if (value instanceof List)
    {
      writeArray(out, (List<?>) value);
      return;
    }
    if (value instanceof Map)
    {
      writeMap(out, (Map<?, ?>) value);
      return;
    }

    writeString(out, String.valueOf(value));
  }

  private void writeArray(DataOutputStream out, List<?> values) throws IOException
  {
    int size = values.size();
    if (size <= 15)
    {
      out.writeByte(0x90 | size);
    }
    else if (size <= 0xffff)
    {
      out.writeByte(0xdc);
      out.writeShort(size);
    }
    else
    {
      out.writeByte(0xdd);
      out.writeInt(size);
    }

    for (Object value : values)
    {
      encode(out, value);
    }
  }

  private void writeBinary(DataOutputStream out, byte[] bytes) throws IOException
  {
    if (bytes.length <= 0xff)
    {
      out.writeByte(0xc4);
      out.writeByte(bytes.length);
    }
    else if (bytes.length <= 0xffff)
    {
      out.writeByte(0xc5);
      out.writeShort(bytes.length);
    }
    else
    {
      out.writeByte(0xc6);
      out.writeInt(bytes.length);
    }
    out.write(bytes);
  }

  private void writeLong(DataOutputStream out, long value) throws IOException
  {
    if (value >= 0 && value <= 0x7f)
    {
      out.writeByte((int) value);
    }
    else if (value >= -32 && value < 0)
    {
      out.writeByte((int) value);
    }
    else if (value >= Byte.MIN_VALUE && value <= Byte.MAX_VALUE)
    {
      out.writeByte(0xd0);
      out.writeByte((int) value);
    }
    else if (value >= Short.MIN_VALUE && value <= Short.MAX_VALUE)
    {
      out.writeByte(0xd1);
      out.writeShort((int) value);
    }
    else if (value >= Integer.MIN_VALUE && value <= Integer.MAX_VALUE)
    {
      out.writeByte(0xd2);
      out.writeInt((int) value);
    }
    else
    {
      out.writeByte(0xd3);
      out.writeLong(value);
    }
  }

  private void writeMap(DataOutputStream out, Map<?, ?> values) throws IOException
  {
    int size = values.size();
    if (size <= 15)
    {
      out.writeByte(0x80 | size);
    }
    else if (size <= 0xffff)
    {
      out.writeByte(0xde);
      out.writeShort(size);
    }
    else
    {
      out.writeByte(0xdf);
      out.writeInt(size);
    }

    for (Map.Entry<?, ?> entry : values.entrySet())
    {
      writeString(out, String.valueOf(entry.getKey()));
      encode(out, entry.getValue());
    }
  }

  private void writeString(DataOutputStream out, String value) throws IOException
  {
    byte[] bytes = value.getBytes(UTF_8);
    if (bytes.length <= 31)
    {
      out.writeByte(0xa0 | bytes.length);
    }
    else if (bytes.length <= 0xff)
    {
      out.writeByte(0xd9);
      out.writeByte(bytes.length);
    }
    else if (bytes.length <= 0xffff)
    {
      out.writeByte(0xda);
      out.writeShort(bytes.length);
    }
    else
    {
      out.writeByte(0xdb);
      out.writeInt(bytes.length);
    }
    out.write(bytes);
  }

  private static int safeLength(int length, int max, String type) throws BaskStreamProtocolException
  {
    if (length < 0)
    {
      throw new BaskStreamProtocolException("bad_request", "Negative MessagePack length.");
    }
    if (length > max)
    {
      throw new BaskStreamProtocolException("bad_request", "MessagePack " + type + " length exceeds maximum size.");
    }
    return length;
  }
}
