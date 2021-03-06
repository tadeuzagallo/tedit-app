
var readPath = require('./fs').readPath;
var publisher = require('./publisher');
var notify = require('ui/notify');
var codec = require('http-codec').server;
var tcpServer = window.chrome.sockets.tcpServer;
var tcp = window.chrome.sockets.tcp;
var binary = require('bodec');
var getMime = require('simple-mime')("text/plain");
var pathJoin = require('pathjoin');
var modes = require('js-git/lib/modes');

module.exports = addServeHook;

function addServeHook(row, settings) {
  var serverId, rootHash;
  var servePath = publisher(readPath, settings);

  tcpServer.create({}, onCreate);

  return hook;

  function onCreate(createInfo) {
    serverId = createInfo.socketId;
    var ip = settings.public ? "0.0.0.0" : "127.0.0.1";
    tcpServer.listen(serverId, ip, settings.port, onListen);
  }

  // TODO: add proper error checking all over this file

  function onListen(result) {
    if (result < 0) console.warn("Negative result to listen", result);
    // Look up the local port to show the user
    tcpServer.getInfo(serverId, function (info) {
      // Show the user a globe icon with port information.
      var address = info.localAddress === "0.0.0.0" ? "localhost" : info.localAddress;
      notify("Local Server at http://" + address + ":" + info.localPort + "/");
      row.serverPort = info.localPort;
    });
    tcpServer.onAccept.addListener(onAccept);
  }

  function onAccept(info) {
    if (info.socketId !== serverId) return;

    var clientId = info.clientSocketId;
    var decode = codec.decoder(onItem);
    var encode = codec.encoder(onOut);


    tcp.getInfo(clientId, function (info) {
      notify("TCP connection from " + info.peerAddress + ":" + info.peerPort);
      tcp.onReceive.addListener(onReceive);
      tcp.setPaused(clientId, false);
    });

    function onReceive(info) {
      if (info.socketId !== clientId) return;
      decode(new Uint8Array(info.data));
    }

    function onOut(binary) {
      if (binary) {
        tcp.send(clientId, binary.buffer, noop);
      }
      else {
        tcp.close(clientId, noop);
      }
    }

    function onItem(item) {
      if (!item.method) return; // TODO: handle request bodies

      // Ensure the request is either HEAD or GET by rejecting everything else
      var head = item.method === "HEAD";
      if (!head && item.method !== "GET") {
        return respond(405, [
          ["Allow", "HEAD,GET"]
        ], "");
      }

      var pathname = item.path.split("?")[0];

      // Normalize the path to work with publisher system
      var path = pathJoin(settings.source, pathname);

      // Put headers in lowercased object for quick access
      var headers = {};
      item.headers.forEach(function (pair) {
        headers[pair[0].toLowerCase()] = pair[1];
      });

      var etag = headers['if-none-match'];
      serve();

      function serve() {
        row.pulse++;
        servePath(path, function (err, result) {
          row.pulse--;
          try { onServe(err, result); }
          catch (err) { row.fail(err); }
        });
      }

      function onServe(err, result) {

        if (err) return error(err);

        if (!(result && result.hash)) {
          return respond(404, [], item.path + " not found");
        }

        if (result.hash && result.hash === etag) {
          // etag matches, no change
          return respond(304, [
            ["Etag", result.hash]
          ], "");
        }

        if (result.mode === modes.tree) {
          // Tell the browser to redirect if they forgot the trailing slash on a tree.
          if (item.path[item.path.length - 1] !== "/") {
            return respond(301, [
              ["Location", item.path + "/"]
            ], "");
          }
          return result.fetch(function (err, tree) {
            if (err) return error(err);
            // Do an internal redirect if an index.html exists
            if (tree["index.html"]) {
              path += "/index.html";
              return serve();
            }
            // Otherwise send the raw JSON
            return respond(200, [
              ["Etag", result.hash],
              ["Content-Type", "application/json"]
            ], JSON.stringify(tree) + "\n");
          });
        }

        result.fetch(function (err, body) {
          if (err) return error(err);
          var resHeaders = [
            ["Etag", result.hash],
            ["Content-Type", result.mime || getMime(path)]
          ];
          body = new Uint8Array(body);
          respond(200, resHeaders, body);
        });
      }

      function error(err) {
        respond(500, [], err.stack);
        row.fail(err);
      }


      function respond(code, headers, body) {
        // Log the request
        notify(item.method + " " + item.path + " " + code);

        if (typeof body === "string") body = binary.fromUnicode(body);
        var contentType, contentLength;
        headers.forEach(function (pair) {
          var key = pair[0].toLowerCase();
          if (key === "content-type") contentType = pair[1];
          else if (key === "content-length") contentLength = pair[1];
        });
        if (!contentType) headers.push(["Content-Type", "text/plain"]);
        if (!contentLength) headers.push(["Content-Length", body.length]);
        encode({
          code: code,
          headers: headers
        });
        encode(body);
        encode();
      }
    }
  }

  function hook(newHash) {
    if (newHash === rootHash) return;
    rootHash = newHash;
    if (!serverId) return;
    // TODO: maybe invalidate some caches if needed?
  }

}

function noop() {}
