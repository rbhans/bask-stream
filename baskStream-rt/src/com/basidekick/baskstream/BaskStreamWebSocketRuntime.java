package com.basidekick.baskstream;

import java.io.IOException;
import java.net.URISyntaxException;
import java.security.Principal;
import java.util.Collection;
import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.logging.Level;

import javax.baja.sys.BasicContext;
import javax.baja.user.BUser;
import javax.servlet.ServletContext;
import javax.servlet.ServletException;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

import org.eclipse.jetty.io.Connection;
import org.eclipse.jetty.server.Connector;
import org.eclipse.jetty.server.HttpConnection;
import org.eclipse.jetty.websocket.common.WebSocketSession;
import org.eclipse.jetty.websocket.common.events.EventDriver;
import org.eclipse.jetty.websocket.common.extensions.ExtensionStack;
import org.eclipse.jetty.websocket.server.HandshakeRFC6455;
import org.eclipse.jetty.websocket.server.WebSocketServerConnection;
import org.eclipse.jetty.websocket.server.WebSocketServerFactory;
import org.eclipse.jetty.websocket.servlet.ServletUpgradeRequest;
import org.eclipse.jetty.websocket.servlet.ServletUpgradeResponse;
import org.eclipse.jetty.websocket.servlet.WebSocketCreator;

final class BaskStreamWebSocketRuntime
{
  private static final String HTTP_CONNECTION_ATTRIBUTE = "org.eclipse.jetty.server.HttpConnection";
  private static final String HTTP_UPGRADE_ATTRIBUTE = "org.eclipse.jetty.server.HttpConnection.UPGRADE";
  private static final String SUPPORTED_WS_VERSION = "13";

  private final BBaskStreamService service;
  private final BaskStreamCodec codec;
  private final BaskStreamPointResolver resolver;
  private final BaskStreamBrowseResolver browseResolver;
  private final BaskStreamHistoryResolver historyResolver;
  private final BaskStreamAlarmResolver alarmResolver;
  private final BaskStreamScheduleResolver scheduleResolver;
  private final BaskStreamWriteResolver writeResolver;
  private final BaskStreamTagResolver tagResolver;
  private final BaskStreamSubscriptionManager subscriptions;
  private final ScheduledExecutorService scheduler;
  private volatile WebSocketServerFactory socketFactory;

  BaskStreamWebSocketRuntime(BBaskStreamService service)
  {
    this.service = service;
    this.codec = new BaskStreamCodec();
    this.resolver = new BaskStreamPointResolver(service);
    this.browseResolver = new BaskStreamBrowseResolver(service);
    this.historyResolver = new BaskStreamHistoryResolver(service);
    this.alarmResolver = new BaskStreamAlarmResolver(service);
    this.scheduleResolver = new BaskStreamScheduleResolver(service);
    this.writeResolver = new BaskStreamWriteResolver(service, resolver);
    this.tagResolver = new BaskStreamTagResolver(service);
    this.subscriptions = new BaskStreamSubscriptionManager(service);
    this.scheduler = Executors.newSingleThreadScheduledExecutor(new BaskStreamThreadFactory());
  }

  void handleUpgrade(HttpServletRequest request, HttpServletResponse response) throws ServletException, IOException
  {
    try
    {
      WebSocketServerFactory factory = ensureFactory(request.getServletContext());
      if (!factory.isUpgradeRequest(request, response))
      {
        response.sendError(HttpServletResponse.SC_BAD_REQUEST, "WebSocket upgrade required.");
        return;
      }
      // CSWSH hardening: optionally require a header-channel credential on the handshake.
      // A cross-site browser script cannot set request headers on a WebSocket handshake,
      // so requiring Authorization defeats cookie-riding hijacks even when the station's
      // web auth would otherwise accept an ambient session cookie. Niagara still performs
      // the actual credential validation; this only enforces the channel.
      if (service.getRequireAuthorizationHeaderValue() && !hasAuthorizationHeader(request))
      {
        service.audit("upgrade_rejected", "reason=missing_authorization_header " + requestAudit(request));
        response.sendError(HttpServletResponse.SC_FORBIDDEN, "Authorization header is required for this endpoint.");
        return;
      }
      if (!isAllowedOrigin(request))
      {
        service.audit("upgrade_rejected", "reason=origin_not_allowed " + requestAudit(request));
        response.sendError(HttpServletResponse.SC_FORBIDDEN, "WebSocket Origin is not allowed.");
        return;
      }

      ServletUpgradeRequest upgradeRequest = new ServletUpgradeRequest(request);
      ServletUpgradeResponse upgradeResponse = new ServletUpgradeResponse(response);
      BaskStreamSocketCreator creator = new BaskStreamSocketCreator(this);
      Object endpoint = creator.createWebSocket(upgradeRequest, upgradeResponse);

      if (upgradeResponse.isCommitted())
      {
        return;
      }
      if (endpoint == null)
      {
        upgradeResponse.sendError(HttpServletResponse.SC_SERVICE_UNAVAILABLE, "Endpoint Creation Failed");
        return;
      }

      endpoint = factory.getObjectFactory().decorate(endpoint);
      EventDriver eventDriver = factory.getEventDriverFactory().wrap(endpoint);
      HttpConnection httpConnection = (HttpConnection) request.getAttribute(HTTP_CONNECTION_ATTRIBUTE);
      if (httpConnection == null)
      {
        throw new ServletException("Jetty HttpConnection attribute not found.");
      }

      performUpgrade(factory, httpConnection, upgradeRequest, upgradeResponse, eventDriver);
    }
    catch (ServletException e)
    {
      throw e;
    }
    catch (IOException e)
    {
      throw e;
    }
    catch (URISyntaxException e)
    {
      throw new IOException("Unable to accept websocket due to mangled URI", e);
    }
    catch (Exception e)
    {
      throw new ServletException("Unable to upgrade baskStream websocket request.", e);
    }
  }

  private void performUpgrade(
      WebSocketServerFactory factory,
      HttpConnection httpConnection,
      ServletUpgradeRequest request,
      ServletUpgradeResponse response,
      EventDriver eventDriver) throws Exception
  {
    String upgrade = request.getHeader("Upgrade");
    if (upgrade == null || !"websocket".equalsIgnoreCase(upgrade))
    {
      throw new IllegalStateException("Not a 'WebSocket: Upgrade' request");
    }
    if (!"HTTP/1.1".equals(request.getHttpVersion()))
    {
      throw new IllegalStateException("Not a 'HTTP/1.1' request");
    }

    int version = request.getHeaderInt("Sec-WebSocket-Version");
    if (version < 0)
    {
      version = request.getHeaderInt("Sec-WebSocket-Draft");
    }
    if (version != 13)
    {
      response.setHeader("Sec-WebSocket-Version", SUPPORTED_WS_VERSION);
      response.sendError(HttpServletResponse.SC_BAD_REQUEST, "Unsupported websocket version specification");
      return;
    }

    ExtensionStack extensions = new ExtensionStack(factory.getExtensionFactory());
    if (response.isExtensionsNegotiated())
    {
      extensions.negotiate(response.getExtensions());
    }
    else
    {
      extensions.negotiate(request.getExtensions());
    }

    Connector connector = httpConnection.getConnector();
    WebSocketServerConnection wsConnection = new WebSocketServerConnection(
        httpConnection.getEndPoint(),
        connector.getExecutor(),
        connector.getScheduler(),
        eventDriver.getPolicy(),
        connector.getByteBufferPool());

    Collection<Connection.Listener> listeners = connector.getBeans(Connection.Listener.class);
    for (Connection.Listener listener : listeners)
    {
      wsConnection.addListener(listener);
    }

    extensions.setPolicy(eventDriver.getPolicy());
    extensions.configure(wsConnection.getParser());
    extensions.configure(wsConnection.getGenerator());

    WebSocketSession session = new WebSocketSession(factory, request.getRequestURI(), eventDriver, wsConnection);
    session.setUpgradeRequest(request);
    response.setExtensions(extensions.getNegotiatedExtensions());
    session.setUpgradeResponse(response);

    wsConnection.addListener(session);
    wsConnection.setNextIncomingFrames(extensions);
    extensions.setNextIncoming(session);
    session.setOutgoingHandler(extensions);
    extensions.setNextOutgoing(wsConnection);
    session.addManaged(extensions);

    request.setServletAttribute(HTTP_UPGRADE_ATTRIBUTE, wsConnection);
    new HandshakeRFC6455().doHandshakeResponse(request, response);
    response.setSuccess(true);
  }

  private synchronized WebSocketServerFactory ensureFactory(ServletContext servletContext) throws Exception
  {
    WebSocketServerFactory existing = socketFactory;
    if (existing != null)
    {
      return existing;
    }

    WebSocketServerFactory created = new WebSocketServerFactory(servletContext);
    created.getPolicy().setIdleTimeout(service.getHeartbeatIntervalSecValue() * 2000L);
    // Bound inbound frames so a single oversized message cannot exhaust JACE memory. Applies to
    // both binary (the real protocol) and text (rejected by the adapter, but capped before buffering).
    int maxMessageBytes = service.getMaxMessageBytesValue();
    created.getPolicy().setMaxBinaryMessageSize(maxMessageBytes);
    created.getPolicy().setMaxTextMessageSize(maxMessageBytes);
    created.start();
    socketFactory = created;
    return created;
  }

  private static boolean hasAuthorizationHeader(HttpServletRequest request)
  {
    String authorization = request.getHeader("Authorization");
    return authorization != null && authorization.trim().length() > 0;
  }

  private static String requestAudit(HttpServletRequest request)
  {
    java.security.Principal principal = request.getUserPrincipal();
    String user = principal == null ? "anonymous" : principal.getName();
    String origin = request.getHeader("Origin");
    return "remote=" + request.getRemoteAddr() + " user=" + user
        + " origin=" + (origin == null ? "-" : origin);
  }

  private boolean isAllowedOrigin(HttpServletRequest request)
  {
    String origin = request.getHeader("Origin");
    if (origin == null || origin.trim().length() == 0)
    {
      // Native clients (e.g. an Electron desktop app) legitimately omit Origin. Browsers
      // always send it on a WebSocket handshake, so a missing Origin is not a browser-CSWSH
      // vector. Deployments that only expect header-authenticated native clients can still
      // reject the ambiguous no-Origin case via rejectMissingOrigin.
      return !service.getRejectMissingOriginValue();
    }

    String normalizedOrigin = normalizeOrigin(origin);
    if (normalizedOrigin == null)
    {
      return false;
    }
    if (normalizedOrigin.equalsIgnoreCase(requestOrigin(request)))
    {
      return true;
    }

    String configured = service.getAllowedOrigins();
    String[] pieces = configured == null ? new String[0] : configured.split("[\\r\\n,;]+");
    for (int i = 0; i < pieces.length; i++)
    {
      String allowed = normalizeOrigin(pieces[i]);
      if (allowed != null && allowed.equalsIgnoreCase(normalizedOrigin))
      {
        return true;
      }
    }
    return false;
  }

  private static String requestOrigin(HttpServletRequest request)
  {
    String scheme = request.getScheme();
    String host = request.getHeader("Host");
    if (host == null || host.trim().length() == 0)
    {
      host = request.getServerName();
      int port = request.getServerPort();
      if (port > 0 && !isDefaultPort(scheme, port))
      {
        host = host + ":" + port;
      }
    }
    return normalizeOrigin(scheme + "://" + host);
  }

  private static String normalizeOrigin(String origin)
  {
    if (origin == null)
    {
      return null;
    }
    String value = origin.trim();
    if (value.length() == 0 || "*".equals(value))
    {
      return null;
    }

    int schemeEnd = value.indexOf("://");
    if (schemeEnd <= 0)
    {
      return null;
    }
    String scheme = value.substring(0, schemeEnd).toLowerCase(Locale.ENGLISH);
    String authority = value.substring(schemeEnd + 3);
    int slash = authority.indexOf('/');
    if (slash >= 0)
    {
      authority = authority.substring(0, slash);
    }
    authority = authority.toLowerCase(Locale.ENGLISH);
    if (authority.startsWith("["))
    {
      int close = authority.indexOf(']');
      if (close < 0)
      {
        return null;
      }
      if (close + 1 < authority.length())
      {
        if (authority.charAt(close + 1) != ':')
        {
          return null;
        }
        try
        {
          int port = Integer.parseInt(authority.substring(close + 2));
          if (isDefaultPort(scheme, port))
          {
            authority = authority.substring(0, close + 1);
          }
        }
        catch (NumberFormatException ignored)
        {
          return null;
        }
      }
    }
    else
    {
      int colon = authority.lastIndexOf(':');
      if (colon > 0)
      {
        try
        {
          int port = Integer.parseInt(authority.substring(colon + 1));
          if (isDefaultPort(scheme, port))
          {
            authority = authority.substring(0, colon);
          }
        }
        catch (NumberFormatException ignored)
        {
          return null;
        }
      }
    }
    return scheme + "://" + authority;
  }

  private static boolean isDefaultPort(String scheme, int port)
  {
    return ("http".equalsIgnoreCase(scheme) && port == 80)
        || ("https".equalsIgnoreCase(scheme) && port == 443);
  }

  BaskStreamCodec getCodec()
  {
    return codec;
  }

  BaskStreamPointResolver getResolver()
  {
    return resolver;
  }

  BaskStreamBrowseResolver getBrowseResolver()
  {
    return browseResolver;
  }

  BaskStreamHistoryResolver getHistoryResolver()
  {
    return historyResolver;
  }

  BaskStreamAlarmResolver getAlarmResolver()
  {
    return alarmResolver;
  }

  BaskStreamScheduleResolver getScheduleResolver()
  {
    return scheduleResolver;
  }

  BaskStreamWriteResolver getWriteResolver()
  {
    return writeResolver;
  }

  BaskStreamTagResolver getTagResolver()
  {
    return tagResolver;
  }

  BBaskStreamService getService()
  {
    return service;
  }

  boolean onOpen(BaskStreamClientSession session)
  {
    return subscriptions.register(session);
  }

  void onClose(BaskStreamClientSession session)
  {
    subscriptions.unregister(session);
  }

  void onSubscriptionCountChanged()
  {
    subscriptions.refreshMetrics();
  }

  ScheduledFuture<?> schedule(Runnable task, long delayMillis)
  {
    long safeDelay = Math.max(0L, delayMillis);
    return scheduler.schedule(new Runnable()
    {
      @Override
      public void run()
      {
        try
        {
          task.run();
        }
        catch (Throwable e)
        {
          service.LOG.log(Level.WARNING, "baskStream scheduled task failed", e);
        }
      }
    }, safeDelay, TimeUnit.MILLISECONDS);
  }

  BaskStreamClientSession buildSession(BaskStreamJettyWebSocketConnection connection, ServletUpgradeRequest request)
      throws BaskStreamProtocolException
  {
    Principal principal = request.getUserPrincipal();
    if (!(principal instanceof BUser))
    {
      throw new BaskStreamProtocolException("auth_required", "Authenticated Niagara user is required.");
    }

    BUser user = (BUser) principal;
    String language = user.getLanguage();
    if (language == null || language.trim().length() == 0)
    {
      Locale locale = request.getLocale();
      language = locale == null ? null : locale.toLanguageTag();
    }
    BasicContext context = language == null || language.trim().length() == 0
        ? new BasicContext(user)
        : new BasicContext(user, language);

    return new BaskStreamClientSession(this, connection, user, context);
  }

  void stop()
  {
    subscriptions.shutdown();
    scheduler.shutdownNow();
    WebSocketServerFactory factory = socketFactory;
    socketFactory = null;
    if (factory != null)
    {
      try
      {
        factory.stop();
      }
      catch (Exception e)
      {
        service.LOG.log(Level.FINE, "Unable to stop baskStream websocket factory cleanly", e);
      }
    }
  }

  private static final class BaskStreamThreadFactory implements ThreadFactory
  {
    private int next;

    @Override
    public Thread newThread(Runnable task)
    {
      Thread thread = new Thread(task, "baskStream-websocket-" + (++next));
      thread.setDaemon(true);
      return thread;
    }
  }

  private static final class BaskStreamSocketCreator implements WebSocketCreator
  {
    private final BaskStreamWebSocketRuntime runtime;

    private BaskStreamSocketCreator(BaskStreamWebSocketRuntime runtime)
    {
      this.runtime = runtime;
    }

    @Override
    public Object createWebSocket(ServletUpgradeRequest request, ServletUpgradeResponse response)
    {
      java.security.Principal principal = request.getUserPrincipal();
      if (principal == null)
      {
        runtime.getService().audit("upgrade_rejected", "reason=unauthenticated");
        try
        {
          response.sendForbidden("Authentication required.");
        }
        catch (IOException e)
        {
          runtime.getService().LOG.log(Level.WARNING, "Unable to reject unauthenticated websocket request", e);
        }
        return null;
      }

      if (runtime.subscriptions.getActiveConnectionCount() >= runtime.getService().getMaxConnectionsValue())
      {
        runtime.getService().audit("upgrade_rejected", "reason=max_connections user=" + principal.getName());
        try
        {
          response.sendError(HttpServletResponse.SC_SERVICE_UNAVAILABLE, "Maximum websocket connection count reached.");
        }
        catch (IOException e)
        {
          runtime.getService().LOG.log(Level.WARNING, "Unable to reject websocket upgrade after max connection check", e);
        }
        return null;
      }

      int perUserCap = runtime.getService().getMaxConnectionsPerUserValue();
      if (perUserCap > 0 && runtime.subscriptions.getConnectionCountForUser(principal.getName()) >= perUserCap)
      {
        runtime.getService().audit("upgrade_rejected", "reason=max_connections_per_user user=" + principal.getName());
        try
        {
          response.sendError(HttpServletResponse.SC_SERVICE_UNAVAILABLE, "Maximum websocket connection count for user reached.");
        }
        catch (IOException e)
        {
          runtime.getService().LOG.log(Level.WARNING, "Unable to reject websocket upgrade after per-user connection check", e);
        }
        return null;
      }

      return new BaskStreamJettyWebSocketConnection(runtime, request);
    }
  }
}
