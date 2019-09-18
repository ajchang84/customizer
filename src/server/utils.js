const path = require("path");
const fs = require("fs-extra");

module.exports = {
    searchRecursive: function searchRecursive(dir, pattern) {
        var results = [];

        fs.readdirSync(dir).forEach(function(dirInner) {
            dirInner = path.resolve(dir, dirInner);

            var stat = fs.statSync(dirInner);

            if (stat.isDirectory()) {
                results = results.concat(searchRecursive(dirInner, pattern));
            }

            if (stat.isFile() && dirInner.endsWith(pattern)) {
                results.push(dir);
            }
        });
        return results;
    },
    deleteFolderRecursive: function deleteFolderRecursive(path) {
        if (fs.existsSync(path)) {
            fs.readdirSync(path).forEach(function(file, index) {
                var curPath = path + "/" + file;
                if (fs.lstatSync(curPath).isDirectory()) {
                    // recurse
                    deleteFolderRecursive(curPath);
                } else {
                    // delete file
                    fs.unlinkSync(curPath);
                }
            });
            fs.rmdirSync(path);
        }
    }
};
