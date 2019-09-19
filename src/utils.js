const path = require("path");
const fs = require("fs-extra");

module.exports = {
    searchRecursive: function searchRecursive(dir, pattern) {
        let results = [];
        fs.readdirSync(dir).forEach(function(dirInner) {
            dirInner = path.resolve(dir, dirInner);
            let stat = fs.statSync(dirInner);
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
                let curPath = path + "/" + file;
                if (fs.lstatSync(curPath).isDirectory()) {
                    deleteFolderRecursive(curPath);
                } else {
                    fs.unlinkSync(curPath);
                }
            });
            fs.rmdirSync(path);
        }
    }
};
