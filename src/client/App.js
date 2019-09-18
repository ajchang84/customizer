import React, { Component, Fragment } from "react";
import "./app.css";
import ReactImage from "./react.png";

export default class App extends Component {
    state = { username: null, images: [] };

    componentDidMount() {
        fetch("/api/getUsername")
            .then(res => res.json())
            .then(user => this.setState({ username: user.username }));
        fetch("/api/getAllOriginals")
            .then(res => res.json())
            .then(files => this.setState({ images: files }));
    }

    render() {
        const { username, images } = this.state;
        return (
            <div>
                {username ? (
                    <h1>{`Hello ${username}`}</h1>
                ) : (
                    <h1>Loading.. please wait!</h1>
                )}
                <a href="/api/download">download</a>
                <br />
                {images.map((imageName, index) => (
                    <Fragment key={index}>
                        <img
                            style={{ width: 100, height: 100 }}
                            src={`/api/getOriginal/${imageName}`}
                        />
                        <span>{imageName}</span>
                        <br />
                    </Fragment>
                ))}
            </div>
        );
    }
}
