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
const DOWNLOAD_PATH = path.join(__dirname, "../../download/");

// env
require("dotenv").config();
const API_DOMAIN = process.env.API_DOMAIN;
// 開發環境 : http://gs_public_api_v2.platformdev.cc:978
// QA環境 : http://uat_gs_public_api.platformdev.cc:978
// 外部UAT : http://gs_public_api.awesomegaming.io:978/

const app = express();
app.use(fileUpload({ createParentPath: true }));
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("dist"));

const SERVER_STATUS_DESC = {
    1: "Service ready",
    2: "Service under maintanence"
};

app.get("/api/getServerStatus", (req, res) => {
    res.send({
        code: SERVER_STATUS.get(),
        desc: SERVER_STATUS_DESC[SERVER_STATUS.get()]
    });
});

app.get("/api/setServerStatus", (req, res) => {
    SERVER_STATUS.change(Number(req.query.code));
    res.send({
        code: 1,
        desc: "success"
    });
});

app.get("/api/getRepo", (req, res) => {
    try {
        deleteFolderRecursive(GAME_CENTER_PATH);
        execSync(
            `git clone ssh://git@10.10.10.38:10022/jenkins/GameCenter.git ${GAME_CENTER_PATH}`
            // git clone --depth 1 --single-branch --branch BAC_QA_0.0.1_0917_1 ssh://git@10.10.10.38:10022/jenkins/baccaratV2.git
        );
        console.log("Cloning done...");
        // request(
        //     {
        //         method: "GET",
        //         uri: `${API_DOMAIN}${API_ROUTES.clean_list}`
        //     },
        //     (err, resp, body) => {
        //         const { code } = JSON.parse(body);
        //         console.log("clean_list", code);
        //     }
        // );
        res.send({ code: 1, desc: "cloned" });
    } catch (err) {
        res.send({ code: -1, desc: "cloning failed" });
    }
});

app.get("/api/download", (req, res) => {
    let project = req.query.project || "bac";
    const currentdate = new Date();
    const datetime =
        project +
        currentdate.getFullYear() +
        (currentdate.getMonth() + 1) +
        currentdate.getDate() +
        "_" +
        currentdate.getHours() +
        currentdate.getMinutes() +
        execSync(`zip -r ${datetime} *`, {
            cwd: DOWNLOAD_PATH
        });
    res.download(path.join(DOWNLOAD_PATH, `/${datetime}.zip`));
});

const TEXTURE_FOLDERS = {
    bac: "BAC",
    bj: "Bj"
};

app.get("/api/getAllTextures", (req, res) => {
    let project = req.query.project || "bac";
    deleteFolderRecursive(DOWNLOAD_PATH);
    fs.mkdirSync(DOWNLOAD_PATH, { recursive: true });
    const traverseDir = (dir, csv) => {
        let data = [];
        fs.readdirSync(dir).forEach(file => {
            let fullPath = path.join(dir, file);
            console.log(fullPath);
            if (fs.lstatSync(fullPath).isDirectory()) {
                data = data.concat(traverseDir(fullPath, csv));
            }
            if (
                fs.lstatSync(fullPath).isFile() &&
                file.match(/\.png$/) &&
                file.match(/^custom/)
                // !!csv[file.toLowerCase().replace(/\.png/, "")]
            ) {
                fs.copyFileSync(fullPath, path.join(DOWNLOAD_PATH, file));

                data.push({
                    path: fullPath.replace(GAME_TEXTURE_PATH, ""),
                    description:
                        csv[file.toLowerCase().replace(/\.png/, "")] || null
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
                const data = [
                    ...traverseDir(
                        path.join(GAME_TEXTURE_PATH, TEXTURE_FOLDERS[project]),
                        csv
                    ),
                    ...traverseDir(path.join(GAME_TEXTURE_PATH, "common"), csv)
                ];
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
    const { token, project } = req.body;
    const RANDOM_HASH = Math.random()
        .toString(36)
        .replace(/[^a-z]+/g, "")
        .substr(0, 5);
    console.log("Uploading...", RANDOM_HASH, project, token);
    try {
        fs.mkdirSync(path.join(TEMPLATE_PATH, RANDOM_HASH), {
            recursive: true
        });
        fs.copySync(GAME_CENTER_PATH, path.join(TEMPLATE_PATH, RANDOM_HASH));
        if (!req.files) {
            res.send({
                code: -1,
                desc: "No file uploaded"
            });
        } else {
            let data = [];
            _.forEach(_.keysIn(req.files.images), key => {
                let image = req.files.images[key];
                let files = searchRecursive(
                    path.join(TEMPLATE_PATH, RANDOM_HASH, "/assets/Texture/"),
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

            console.log("Finished uploading...");
            request(
                {
                    method: "POST",
                    form: { token },
                    uri: `${API_DOMAIN}${API_ROUTES.upload_done}`
                },
                (err, resp, body) => {
                    const { code, desc } = JSON.parse(body);
                    console.log(body);
                    if (code === 1) {
                        console.log("upload_done", desc);
                        console.log("Winding up builder...");
                        setTimeout(
                            () => buildProject(RANDOM_HASH, token, project),
                            1500
                        );

                        res.send({
                            code: 1,
                            desc: "Files are uploaded",
                            data: data
                        });
                    } else {
                        console.log("upload_done_fail", code, desc);
                        res.send(body);
                    }
                }
            );
        }
    } catch (err) {
        res.status(500).send({ desc: err });
    }
});

const buildProject = (randomHash, token, project) => {
    console.log("Building with cocos...");

    request(
        {
            method: "POST",
            form: { token, project },
            uri: `${API_DOMAIN}${API_ROUTES.package_start}`
        },
        (err, resp, body) => {
            console.log("package_start", body);
        }
    );

    exec(
        `node gameSettingBuilder.js ${project}`,
        { cwd: path.join(TEMPLATE_PATH, randomHash) },
        (error, stdout, stderr) => {
            console.log(stdout);
            const cocosBuilder = spawn(
                "/Applications/CocosCreator3.app/Contents/MacOS/CocosCreator",
                [
                    "--path",
                    path.join(TEMPLATE_PATH, randomHash),
                    "--build",
                    "platform=web-desktop;md5Cache=false;"
                ]
            );
            cocosBuilder.stdout.on("data", data => {
                console.log("stdout:", data.toString());
            });
            cocosBuilder.stderr.on("data", data => {
                console.log("stderr:", data.toString());
            });
            cocosBuilder.on("exit", code => {
                console.log("Done building with cocos with code:", code);
                setTimeout(() => moveProject(randomHash, token, project), 3000);
            });
        }
    );
};

const PROJECT_PATH = {
    bac: "ASBaccarat",
    bj: "ASBJ21"
};

const PROJECT_URL = {
    bac: "baccarat",
    bj: "bj21"
};

const moveProject = (randomHash, token, project) => {
    console.log(`Moving project to ${randomHash}`);
    execSync(`
        ssh develop@10.10.10.40 -p 9527 "mkdir Dev_hotUpdate/web/GameCenter/${PROJECT_PATH[project]}/res/${randomHash}"
    `);
    execSync(`
        scp -P 9527 -r ${path.join(
            TEMPLATE_PATH,
            randomHash,
            "/build/web-desktop/res/raw-assets"
        )} develop@10.10.10.40:Dev_hotUpdate/web/GameCenter/${
        PROJECT_PATH[project]
    }/res/${randomHash}
    `);
    console.log("Done moving project...");
    request(
        {
            method: "POST",
            form: {
                token,
                demo_url: `http://10.10.10.40:84/${PROJECT_URL[project]}/?temp=${randomHash}`
            },
            uri: `${API_DOMAIN}${API_ROUTES.package_done}`
        },
        (err, resp, body) => {
            console.log("package_done", body);
        }
    );
};

cron.schedule("59 23 * * *", function() {
    console.log("Running a task from cron");
    try {
        // deleteFolderRecursive(GAME_CENTER_PATH);
        // execSync(
        //     `git clone ssh://git@10.10.10.38:10022/jenkins/GameCenter.git ${GAME_CENTER_PATH}`
        // );
        // console.log("Cloning done...");
        deleteFolderRecursive(TEMPLATE_PATH);
        fs.mkdirSync(TEMPLATE_PATH, { recursive: true });
        console.log("Clearing all templates done...");
    } catch (err) {
        console.log("Clearing all templates failed...");
    }
});

app.listen(process.env.PORT || 8080, () =>
    console.log(`Listening on port ${process.env.PORT || 8080}!`)
);
