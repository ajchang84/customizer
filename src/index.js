const express = require("express");
const bodyParser = require("body-parser");
const cron = require("node-cron");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const path = require("path");
const _ = require("lodash");
const fs = require("fs-extra");
const { exec, execSync, spawn } = require("child_process");
const request = require("request");
const { searchRecursive, deleteFolderRecursive } = require("./utils");
const SERVER_STATUS = require("./status");
const API_ROUTES = require("./api");

const GAME_CENTER_PATH = path.join(__dirname, "../../GameCenter/");
const GAME_TEXTURE_PATH = path.join(GAME_CENTER_PATH, "/assets/Texture/");
const TEMPLATE_PATH = path.join(__dirname, "../../Template/");
const TEMPLATE_TEXTURE_PATH = path.join(TEMPLATE_PATH, "/assets/Texture/");

// env
require("dotenv").config();
const API_DOMAIN = process.env.API_DOMAIN;
let API_TOKEN = null;
// 開發環境 : http://gs_public_api_v2.platformdev.cc:978
// QA環境 : http://uat_gs_public_api.platformdev.cc:978
// 外部UAT : http://gs_public_api.awesomegaming.io:978/

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

app.get("/api/getServerStatus", (req, res) => {
    res.send({ status: SERVER_STATUS.get() });
});

app.get("/api/getRepo", (req, res) => {
    try {
        deleteFolderRecursive(GAME_CENTER_PATH);
        execSync(
            `git clone ssh://git@10.10.10.38:10022/jenkins/GameCenter.git ${GAME_CENTER_PATH}`
            // git clone --depth 1 --single-branch --branch BAC_QA_0.0.1_0917_1 ssh://git@10.10.10.38:10022/jenkins/baccaratV2.git
        );
        console.log("Cloning done...");
        res.send({ code: 1, desc: "cloned" });
    } catch (err) {
        res.send({ code: -1, desc: "cloning failed" });
    }
});

app.get("/api/download", (req, res) => {
    execSync(`zip -r archive *`, {
        cwd: GAME_TEXTURE_PATH
    });

    res.download(path.join(GAME_TEXTURE_PATH, "/archive.zip"));
});

app.get("/api/getAllTextures", (req, res) => {
    const traverseDir = (dir, csv) => {
        let data = [];
        fs.readdirSync(dir).forEach(file => {
            let fullPath = path.join(dir, file);
            if (fs.lstatSync(fullPath).isDirectory()) {
                data = data.concat(traverseDir(fullPath, csv));
            }
            if (
                fs.lstatSync(fullPath).isFile() &&
                file.match(/\.png$/) &&
                !!csv[file.toLowerCase().replace(/\.png/, "")]
            ) {
                data.push({
                    path: fullPath.replace(GAME_TEXTURE_PATH, ""),
                    description: csv[file.toLowerCase().replace(/\.png/, "")]
                });
            }
        });
        return data;
    };

    request(
        {
            method: "GET",
            uri: `${API_DOMAIN}${API_ROUTES.get_config_list}`
        },
        (err, resp, body) => {
            const { code, config = [] } = JSON.parse(body);
            if (code === 1) {
                console.log("get_config_list csv", config.length, "files");
                const csv = config.reduce((p, c) => {
                    p[c.name.toLowerCase()] = c.description;
                    return p;
                }, {});
                const data = traverseDir(GAME_TEXTURE_PATH, csv);
                console.log("get_config_list texture", data.length, "files");

                res.send(data);
            }
        }
    );
});

app.get("/api/getTexture*", (req, res) => {
    res.sendFile(path.join(GAME_TEXTURE_PATH, `/${req.params[0]}`));
});

app.post("/api/uploadBatch", async (req, res) => {
    if (SERVER_STATUS.get() === 1) {
        request(
            {
                method: "POST",
                form: { token: req.body.token },
                uri: `${API_DOMAIN}${API_ROUTES.upload_start}`
            },
            (err, resp, body) => {
                console.log("upload_start", body);
                const { code, token = "" } = JSON.parse(body);
                if (code === 1) {
                    console.log("Uploading...");
                    try {
                        deleteFolderRecursive(TEMPLATE_PATH);
                        fs.mkdirSync(TEMPLATE_PATH, { recursive: true });
                        fs.copySync(GAME_CENTER_PATH, TEMPLATE_PATH);

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
                                let files = searchRecursive(
                                    TEMPLATE_TEXTURE_PATH,
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
                            request(
                                {
                                    method: "POST",
                                    form: { token: API_TOKEN },
                                    uri: `${API_DOMAIN}${API_ROUTES.upload_done}`
                                },
                                (err, resp, body) => {
                                    console.log("upload_done", body);
                                }
                            );
                            console.log("Winding up builder...");

                            setTimeout(() => buildProject(), 3000);
                        }
                    } catch (err) {
                        res.status(500).send(err);
                    }
                } else {
                    res.send(body);
                }
            }
        );
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

    request(
        {
            method: "POST",
            form: { token: API_TOKEN },
            uri: `${API_DOMAIN}${API_ROUTES.package_start}`
        },
        (err, resp, body) => {
            console.log("package_start", body);
        }
    );
    // execSync(`rm -rf ${path.join(TEMPLATE_PATH, "/node_modules")}`);
    // execSync(`rm -rf ${__dirname}/Template/local`);
    // execSync(`rm -rf ${__dirname}/Template/library`);
    // execSync(`rm -rf ${__dirname}/Template/temp`);
    // execSync(`rm -rf ${path.join(TEMPLATE_PATH, "/assets/Scripts/Bj")}`);
    exec(
        "node gameSettingBuilder.js bac",
        { cwd: TEMPLATE_PATH },
        (error, stdout, stderr) => {
            console.log(stdout);
            exec(
                `/Applications/CocosCreator3.app/Contents/MacOS/CocosCreator --path ${TEMPLATE_PATH} --build "platform=web-desktop;md5Cache=false;"`,
                (err, stdout, stderr) => {
                    console.log("Done building with cocos...", stdout);
                    setTimeout(() => moveProject(), 3000);
                }
            );
        }
    );
};

const moveProject = () => {
    const randomHash = Math.random()
        .toString(36)
        .replace(/[^a-z]+/g, "")
        .substr(0, 5);

    console.log(`Moving project to ${randomHash}`);
    execSync(`
        ssh develop@10.10.10.40 -p 9527 "mkdir Dev_hotUpdate/web/GameCenter/ASBaccarat/res/${randomHash}"
    `);
    execSync(`
        scp -P 9527 -r ${path.join(
            TEMPLATE_PATH,
            "/build/web-desktop/res/raw-assets"
        )} develop@10.10.10.40:Dev_hotUpdate/web/GameCenter/ASBaccarat/res/${randomHash}
    `);
    console.log("Done moving project...");
    request(
        {
            method: "POST",
            form: {
                token: API_TOKEN,
                demo_url: `http://10.10.10.40:84/baccarat/?temp=${randomHash}`
            },
            uri: `${API_DOMAIN}${API_ROUTES.package_done}`
        },
        (err, resp, body) => {
            console.log("package_done", body);
        }
    );
    SERVER_STATUS.change(1);
};

cron.schedule("59 23 * * *", function() {
    console.log("Running a task from cron");
    try {
        deleteFolderRecursive(GAME_CENTER_PATH);
        execSync(
            `git clone ssh://git@10.10.10.38:10022/jenkins/GameCenter.git ${GAME_CENTER_PATH}`
        );
        console.log("Cloning done...");
    } catch (err) {
        console.log("Cloning failed...");
    }
});

app.listen(process.env.PORT || 8080, () =>
    console.log(`Listening on port ${process.env.PORT || 8080}!`)
);
