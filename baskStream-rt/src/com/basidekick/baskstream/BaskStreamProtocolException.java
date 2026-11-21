package com.basidekick.baskstream;

import java.util.Map;

final class BaskStreamProtocolException extends Exception
{
  private final String code;
  /** Extra fields for the error reply, such as the proposal a change became. May be null. */
  private final Map<String, Object> details;

  BaskStreamProtocolException(String code, String message)
  {
    this(code, message, null);
  }

  BaskStreamProtocolException(String code, String message, Map<String, Object> details)
  {
    super(message);
    this.code = code;
    this.details = details;
  }

  String getCode()
  {
    return code;
  }

  Map<String, Object> getDetails()
  {
    return details;
  }
}
