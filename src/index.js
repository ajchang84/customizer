const express = require("express");
const bodyParser = require("body-parser");
const cron = require("node-cron");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const path = require("path");
const _ = require("lodash");
const os = require("os");
const fs = require("fs-extra");
const child_process = require("child_process");
const request = require("request");

// env
require("dotenv").config();
const API_DOMAIN = process.env.API_DOMAIN;
let API_TOKEN = null;
// 開發環境 : http://gs_public_api_v2.platformdev.cc:978
// QA環境 : http://uat_gs_public_api.platformdev.cc:978
// 外部UAT : http://gs_public_api.awesomegaming.io:978/

const utils = require("./utils");
const SERVER_STATUS = require("./status");

const app = express();
app.use(
    fileUpload({
        createParentPath: true
    })
);
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("dist"));

app.get("/api/getUsername", (req, res) =>
    res.send({ username: os.userInfo().username })
);

app.get("/api/getServerStatus", (req, res) => {
    res.send({ status: SERVER_STATUS.get() });
});

app.get("/api/getRepo", (req, res) => {
    try {
        utils.deleteFolderRecursive(path.join(__dirname), "../../GameCenter/");
        child_process.execSync(`
            git clone ssh://git@10.10.10.38:10022/jenkins/GameCenter.git ${path.join(
                __dirname,
                "../../GameCenter/"
            )}`);
        // git clone --depth 1 --single-branch --branch BAC_QA_0.0.1_0917_1 ssh://git@10.10.10.38:10022/jenkins/baccaratV2.git
        console.log("Cloning done...");
        res.send({ code: 1, desc: "cloned" });
    } catch (err) {
        res.send({ code: 500, desc: "OUCH" });
    }
    // request(GET_TAGS, (err, resp, body) => {
    //     console.log(body);
    //     res.send(body);
    // });
});

app.get("/api/download", (req, res) => {
    const folderpath = `${__dirname}/GameCenter/assets/Texture/`;

    child_process.execSync(`zip -r archive *`, {
        cwd: folderpath
    });

    res.download(folderpath + "/archive.zip");
});

app.get("/api/getAllTextures", (req, res) => {
    let data = [];
    let csv = {};
    const traverseDir = dir => {
        fs.readdirSync(dir).forEach(file => {
            let fullPath = path.join(dir, file);
            if (fs.lstatSync(fullPath).isDirectory()) {
                traverseDir(fullPath);
            } else {
                if (file.match(/\.png$/)) {
                    if (!!csv[file.toLowerCase().replace(/\.png/, "")]) {
                        data.push({
                            path: fullPath.replace(
                                `${__dirname}/GameCenter/assets/Texture/`,
                                ""
                            ),
                            description:
                                csv[file.toLowerCase().replace(/\.png/, "")]
                        });
                    }
                }
            }
        });
    };

    const params = {
        method: "GET",
        uri: `${API_DOMAIN}/backend/platform_change_skin/get_config_list`
    };

    request(params, (err, resp, body) => {
        console.log("get_config_list");
        const { code, config = [] } = JSON.parse(body);
        if (code === 1) {
            csv = config.reduce((p, c) => {
                p[c.name.toLowerCase()] = c.description;
                return p;
            }, {});
            traverseDir(`${__dirname}/GameCenter/assets/Texture/`);
            res.send(data);
        }
    });
});

app.get("/api/getTexture*", (req, res) => {
    res.sendFile(`${__dirname}/GameCenter/assets/Texture/${req.params[0]}`);
});

app.post("/api/uploadBatch", async (req, res) => {
    if (SERVER_STATUS.get() === 1) {
        const params = {
            method: "POST",
            form: {
                token: req.body.token
            },
            uri: `${API_DOMAIN}/backend/platform_change_skin/upload_start
            `
        };

        request(params, (err, resp, body) => {
            console.log("upload_start", body);
            const { code, token = "" } = JSON.parse(body);
            if (code === 1) {
                console.log("Uploading...");
                try {
                    utils.deleteFolderRecursive(`${__dirname}/Template/`);
                    fs.mkdirSync(`${__dirname}/Template/`, { recursive: true });
                    fs.copySync(
                        `${__dirname}/GameCenter/`,
                        `${__dirname}/Template/`
                    );

                    if (!req.files) {
                        res.send({
                            status: false,
                            message: "No file uploaded"
                        });
                    } else {
                        let data = [];
                        API_TOKEN = token;
                        _.forEach(_.keysIn(req.files.images), key => {
                            let image = req.files.images[key];
                            var files = utils.searchRecursive(
                                `${__dirname}/Template/assets/Texture`,
                                image.name
                            );
                            files.forEach(file => {
                                image.mv(`${file}/` + image.name);
                            });
                            data.push({
                                name: image.name,
                                mimetype: image.mimetype,
                                size: image.size
                            });
                        });

                        res.send({
                            code: 1,
                            desc: "Files are uploaded",
                            data: data
                        });

                        SERVER_STATUS.change(2);
                        console.log("Finished uploading...");
                        const params = {
                            method: "POST",
                            form: {
                                token: API_TOKEN
                            },
                            uri: `${API_DOMAIN}/backend/platform_change_skin/upload_done`
                        };

                        request(params, (err, resp, body) => {
                            console.log("upload_done", body);
                        });
                        console.log("Winding up builder...");

                        setTimeout(() => buildProject(), 3000);
                    }
                } catch (err) {
                    res.status(500).send(err);
                }
            } else {
                res.send(body);
            }
        });
    } else {
        res.send({
            code: 999,
            desc: "server busy processing current build."
        });
    }
});

app.get("/api/buildProject", (req, res) => {
    buildProject();
    res.send({
        status: true,
        message: "Project built"
    });
});

app.get("/api/moveAssets", (req, res) => {
    moveProject();
    res.send({
        status: true,
        message: "Project moved"
    });
});

const buildProject = () => {
    console.log("Building with cocos...");
    const params = {
        method: "POST",
        form: {
            token: API_TOKEN
        },
        uri: `${API_DOMAIN}/backend/platform_change_skin/package_start`
    };

    request(params, (err, resp, body) => {
        console.log("package_start", body);
    });
    child_process.execSync(`rm -rf ${__dirname}/Template/node_modules`);
    // child_process.execSync(`rm -rf ${__dirname}/Template/local`);
    // child_process.execSync(`rm -rf ${__dirname}/Template/library`);
    // child_process.execSync(`rm -rf ${__dirname}/Template/temp`);
    child_process.execSync(`rm -rf ${__dirname}/Template/assets/Scripts/Bj`);
    child_process.exec(
        `/Applications/CocosCreator3.app/Contents/MacOS/CocosCreator --path ${__dirname}/Template/ --build "title=Bacarrat;platform=web-desktop;md5Cache=false;"`,
        (err, stdout, stderr) => {
            console.log("Done building with cocos...");
            setTimeout(() => moveProject(), 3000);
        }
    );
};

const moveProject = () => {
    const randomHash = Math.random()
        .toString(36)
        .replace(/[^a-z]+/g, "")
        .substr(0, 5);

    console.log(`Moving project to ${randomHash}...`);
    child_process.execSync(`
        ssh develop@10.10.10.40 -p 9527 "mkdir Dev_hotUpdate/web/GameCenter/ASBaccarat/res/${randomHash}"
    `);
    child_process.execSync(`
        scp -P 9527 -r ${__dirname}/Template/build/web-desktop/res/raw-assets develop@10.10.10.40:Dev_hotUpdate/web/GameCenter/ASBaccarat/res/${randomHash}
    `);
    console.log("Done moving project...");
    const params = {
        method: "POST",
        form: {
            token: API_TOKEN,
            demo_url: `http://10.10.10.40:84/baccarat/?temp=${randomHash}`
        },
        uri: `${API_DOMAIN}/backend/platform_change_skin/package_done`
    };
    request(params, (err, resp, body) => {
        console.log("package_done", body);
    });
    SERVER_STATUS.change(1);
};

cron.schedule("59 23 * * *", function() {
    console.log("Running a task from cron");
    try {
        utils.deleteFolderRecursive(`${__dirname}/GameCenter/`);
        child_process.execSync(`
            git clone ssh://git@10.10.10.38:10022/jenkins/GameCenter.git ${__dirname}/GameCenter/
        `);
        console.log("Cloning done...");
    } catch (err) {
        console.log("Cloning failed...");
    }
});

app.listen(process.env.PORT || 8080, () =>
    console.log(`Listening on port ${process.env.PORT || 8080}!`)
);
