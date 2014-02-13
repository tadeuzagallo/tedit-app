"use strict";

var pathJoin = require('../lib/pathjoin.js');
var rescape = require('../lib/rescape.js');
var modes = require('../js-git/lib/modes.js');

// pathToEntry accepts a path and returns {mode,hash,{tree|link}} in callback
// handleCommand takes req and returns {etag,{tree|fetch},{mime}}
// req contains(...TODO: document...)
module.exports = function (pathToEntry, handleCommand) {

  return servePath;

  function servePath(path, etag, callback) {
    if (!callback) return servePath.bind(null, path, etag);
    // console.log("servePath", path);
    return pathToEntry(path, onEntry);

    function onEntry(err, entry, repo) {
      if (!entry) return callback(err);

      // Trees go straight through, but expand wildcard symlinks first
      if (entry.tree) {
        return expandTree(repo, path, entry.tree, function (err, tree) {
          if (err) return callback(err);
          callback(null, {tree: tree});
        });
      }

      // If the request etag matches what's still there, we're done!
      if (etag && etag === entry.hash) {
        return callback(null, {etag:etag});
      }

      // Serve files as-is with lazy body.
      if (modes.isFile(entry.mode)) {
        // Static file, serve it as-is.
        return callback(null, {etag: entry.hash, fetch: function (callback) {
          entry.repo.loadAs("blob", entry.hash, callback);
        }});
      }

      // Ensure that only symlinks make it past this.
      if (entry.mode !== modes.sym) return callback(new Error("Invalid mode"));

      // Symbolic links can have optional filters or wildcard matches.
      var index = entry.link.indexOf("|");
      var target = entry.link.substr(0, index);
      var args = entry.link.substr(index + 1).split(" ");
      var name = args.shift();

      var req = {
        hash: entry.hash,
        path: path,
        etag: etag,
        name: name,
        args: args,
      };

      // If there was no target, we're done preparing the request
      if (!target) return handleCommand(req, callback);

      // Otherwise, load the entry for the target too.
      // This adds {targetPath,target} to req.
      req.targetPath = pathJoin(path, "..", target);
      return servePath(req.targetPath, null, function (err, target) {
        if (!target) return callback(err);
        req.target = target;
        handleCommand(req, callback);
      });
    }
  }

  function expandTree(repo, path, tree, callback) {
    var newTree = {};
    var toResolve = {};
    Object.keys(tree).forEach(function (name) {
      var entry = tree[name];
      if (entry.mode === modes.sym && /\{[a-z]+\}/.test(name)) {
        toResolve[name] = entry;
      }
      else {
        newTree[name] = entry;
      }
    });

    var left = 1;
    Object.keys(toResolve).forEach(function (name) {
      var entry = toResolve[name];
      var parts, targetRepo;
      left++;
      repo.loadAs("text", entry.hash, onTarget);

      function onTarget(err, link) {
        if (err) return callback(err);
        parts = compile(path, name, link);
        pathToEntry(parts.dir, onEntry);
      }

      function onEntry(err, entry, result) {
        if (!entry || entry.mode !== modes.tree) return callback(err || new Error("Missing tree " + parts.dir));
        targetRepo = result;
        repo.loadAs("tree", entry.hash, onTree);
      }

      function onTree(err, tree) {
        if (!tree) return callback(err || new Error("Missing tree hash"));
        expandTree(targetRepo, parts.dir, tree, onExpandedTree);
      }

      function onExpandedTree(err, tree) {
        if (err) return callback(err);
        Object.keys(tree).forEach(function (name) {
          var match = name.match(parts.pattern);
          if (!match) return;
          var newName = parts.original.replace(parts.variable, match[1]);
          // Don't override existing entries
          if (newTree[newName]) return;
          newTree[newName] = {
            mode: modes.sym,
            link: parts.target.replace(parts.variable, match[1])
          };
          check();
        });
      }
    });
    check();

    function check() {
      if (--left) return;
      callback(null, newTree);
    }
  }

};

function compile(srcDir, srcName, target) {
  // This assumes target has the {name} in the last segment
  var index = target.indexOf("|");
  var targetName;
  if (index >= 0) {
    targetName = target.substring(0, index);
  }
  else {
    targetName = target;
  }
  index = targetName.lastIndexOf("/");
  var targetDir = targetName.substring(0, index);
  targetName = targetName.substring(index + 1);

  var dir = pathJoin(srcDir, targetDir);

  var match = targetName.match("^(.*)({[a-z]+})(.*)$");
  var variable = match[2];
  var pattern = new RegExp("^" + rescape(match[1]) + "(.+)" + rescape(match[3]) + "$");

  return {
    original: srcName,
    variable: variable,
    pattern: pattern,
    target: target,
    dir: dir
  };
}