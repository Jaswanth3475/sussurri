import React, { useState, useRef, useEffect } from "react";
import io from "socket.io-client";
import "./styles.css";
import {
    TranscribeStreamingClient,
    StartStreamTranscriptionCommand
  } from '@aws-sdk/client-transcribe-streaming';
import pEvent from 'p-event';

const socket = io("https://sussurri-dbb0a0404bde.herokuapp.com/"); 

const CallAwsStreaming = () => {
    const [language, setLanguage] = useState("en-US");
    const localStreamRef = useRef(null);
    const localAudioStreamRef = useRef(null);
    const remoteStreamRef = useRef(null);
    const peerConnectionRef = useRef(null);
    const audioContextRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const mediaBufferRef = useRef([]);
    const audioRecorderRef = useRef(null);
    const workletNode = useRef(null);

    const transaltedAudioBufferRef = useRef([])

    const lastPlayedIndex = useRef(0)

    const [isCallOnGoing, setIsCallOnGoing] = useState(false);
    const [isCallReceiving, setIsCallReceiving] = useState(false);
    const [peerId, setPeerId] = useState("");
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);
    const [transcribedText, setTranscribedText] = useState("");
    const [isAudioProcessing, setIsAudioProcessing] = useState(false);
    
    // const [audioIndexCounter, setAudioIndexCounter] = useState(1);
    const audioIndexCounter = useRef(1);
    const [currentAudioIndex, setCurrentAudioIndex] = useState(null);
    const [textToTranslate, setTextToTranslate] = useState("");

    var shouldProcessAudio = false;
    var isCallStarted = false;

    useEffect(() => {
        sessionStorage.setItem("shouldProcessAudio", shouldProcessAudio);
        sessionStorage.setItem("isCallStarted", isCallStarted);

        const getMedia = async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    video: true,
                });
                console.log("Local stream obtained:", stream);
                if (localStreamRef.current) {
                    localStreamRef.current.srcObject = stream;
                }
                initializePeerConnection(stream);

                socket.emit("join");

                // Setup MediaRecorder for audio capturing
                if (
                    !audioContextRef.current ||
                    audioContextRef.current.state === "closed"
                ) {
                    audioContextRef.current = new (window.AudioContext ||
                        window.webkitAudioContext)();
                }

                mediaRecorderRef.current = new MediaRecorder(stream);
                mediaRecorderRef.current.ondataavailable = (event) => {
                    if (event.data.size > 0) {
                        mediaBufferRef.current.push(event.data);
                    }
                };

                mediaRecorderRef.current.start(1000); // Record audio in chunks of 1 second
            } catch (error) {
                console.error("Error accessing media devices.", error);
            }
        };

        getMedia();

        // Send the selected language to the server
        socket.emit("set-language", { id: socket.id, sourceLanguage: language });

        socket.on("signal", async (data) => {
            console.log("Received signal:", data.type, data);
            try {
                if (data.type === "offer") {
                    console.log("Setting remote description for offer");
                    setIsCallReceiving(true);
                    await peerConnectionRef.current.setRemoteDescription(
                        new RTCSessionDescription(data)
                    );
                    setPeerId(data.from);
                } else if (data.type === "answer") {
                    console.log("Setting remote description for answer");
                    await peerConnectionRef.current.setRemoteDescription(
                        new RTCSessionDescription(data)
                    );
                    setPeerId(data.from);
                    socket.targetLanguage = data.targetLanguage;

                    isCallStarted = true;
                    sessionStorage.setItem("isCallStarted", isCallStarted);
        
                    startRecording();

                } else if (data.type === "candidate") {
                    console.log("Received ICE candidate");
                    if (peerConnectionRef.current.remoteDescription) {
                        await peerConnectionRef.current.addIceCandidate(
                            new RTCIceCandidate(data.candidate)
                        );
                    } else {
                        console.warn(
                            "Buffering ICE candidate because remote description is not set"
                        );
                    }
                }
            } catch (error) {
                console.error("Error handling signal:", error);
            }
        });

        socket.on("peer-joined", (data) => {
            console.log("Peer joined:", data.id);
            setPeerId(data.id);
            if (
                !peerConnectionRef.current ||
                peerConnectionRef.current.signalingState === "closed"
            ) {
                initializePeerConnection(localStreamRef.current.srcObject);
            }
        });

        socket.on("peer-disconnected", (data) => {
            console.log("Peer disconnected:", data.id);
            if (peerId === data.id && remoteStreamRef.current) {
                remoteStreamRef.current.srcObject = null;
            }
            setPeerId("");
            isCallStarted = false;
            sessionStorage.setItem("isCallStarted", isCallStarted);
        });

        socket.on("end-call", () => {
            console.log("End call received");
            handleEndCall(false);
        });

        socket.on("transcription", (data) => {
            console.log("Received transcription:", data.text);
            setTranscribedText(transcribedText + " \n " + data.text);
        });

        socket.on("translated-text", (data) => {
            console.log("Received translation:", data.text);
        });

        socket.on("audio-processing", (data) => {
            setIsAudioProcessing(true)
        });

        socket.on("audio-error", (data) => {
            console.log("audio-error:::", data)
            //setAudioIndexCounter(audioIndexCounter - 1)
            
            decrementAudioIndexCounter();
        });

        socket.on("audio", (data) => {
            console.log("Received translated audio:", data);
            if(data.audio.byteLength > 0){
                setIsAudioProcessing(false);
                const audioStream = data.audio;
                var uInt8Array = new Uint8Array(audioStream);
                var arrayBuffer = uInt8Array.buffer;
                var blob = new Blob([arrayBuffer]);
                var url = URL.createObjectURL(blob);
                const audio = new Audio(url);
                var isAudioTriggered = false;
                var isCurrentIndexPresent;
                // ToDo: Wait for current audio to complete before initiating a new one
                if(data.audIndex === 1){
                    isCurrentIndexPresent = transaltedAudioBufferRef.current.find((obj) => {return obj.audIndex === data.audIndex})
                    if(!isCurrentIndexPresent){
                        transaltedAudioBufferRef.current.push({audio: null, duration:data.duration, audIndex: data.audIndex, status: "Played"})
                        console.log('Playing audio with duration:', data.duration)
                        isAudioTriggered = true;
                        audio.onended = () => {
                            lastPlayedIndex.current = data.audIndex;
                            console.log("in audio end 1");
                            isAudioTriggered = false;
                            playAllAudio();
                        }
                        
                        audio.play();
                    }
                }
                else{
                    isCurrentIndexPresent = transaltedAudioBufferRef.current.find((obj) => {return obj.audIndex === data.audIndex})
                    if(!isCurrentIndexPresent){
                        transaltedAudioBufferRef.current.push({audio: audio, duration:data.duration, audIndex: data.audIndex, status: "Queued"})
                        if(!isAudioTriggered){
                            playAllAudio();
                        }
                    }    
                }
            }
        });

        return () => {
            if (peerConnectionRef.current) {
                peerConnectionRef.current.close();
            }
            socket.off("signal");
            socket.off("peer-joined");
            socket.off("peer-disconnected");
            socket.off("transcription");
        };
    }, [peerId]);


    useEffect(() => {
        if (transcribedText) {
            handleFinalTranscript(transcribedText)
        }
      // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [transcribedText]);

    const decrementAudioIndexCounter = () => {
        audioIndexCounter.current = audioIndexCounter.current - 1;
        console.log("AIC::::", audioIndexCounter.current)
    }

    const playAllAudio = () => {
        // Sorting the array based on the 'audIndex' parameter
        transaltedAudioBufferRef.current = [...transaltedAudioBufferRef.current].sort((a, b) => a.audIndex - b.audIndex);
        transaltedAudioBufferRef.current.forEach((audioObj) => {
            if(audioObj.audIndex - 1 === lastPlayedIndex.current && audioObj.status === "Queued"){
                audioObj.audio.onended = () => {
                    lastPlayedIndex.current = audioObj.audIndex
                    console.log("in audio end for index::::", audioObj.audIndex)
                    playAllAudio();
                }
                audioObj.status = "Played"
                audioObj.audio.play();
            }
            else{
                console.log("in else")
            }
        });
    }

    const initializePeerConnection = (stream) => {
        if (peerConnectionRef.current) {
            peerConnectionRef.current.close();
        }

        peerConnectionRef.current = new RTCPeerConnection({
            iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:19302" },
            ],
        });

        peerConnectionRef.current.ontrack = (event) => {
            console.log("ontrack event:", event);
            const [remoteStream] = event.streams;
            console.log("Remote stream received:", remoteStream);
            if (remoteStreamRef.current) {
                remoteStreamRef.current.srcObject = remoteStream;
            } else {
                console.error("remoteStreamRef.current is null");
            }
        };

        peerConnectionRef.current.onicecandidate = (event) => {
            if (event.candidate) {
                console.log("Sending ICE candidate:", event.candidate);
                socket.emit("signal", {
                    type: "candidate",
                    candidate: event.candidate,
                    to: peerId,
                });
            }
        };

        peerConnectionRef.current.oniceconnectionstatechange = () => {
            console.log(
                "ICE connection state:",
                peerConnectionRef.current.iceConnectionState
            );
        };

        peerConnectionRef.current.onconnectionstatechange = () => {
            console.log(
                "Peer connection state:",
                peerConnectionRef.current.connectionState
            );
            if (
                peerConnectionRef.current.connectionState === "disconnected" ||
                peerConnectionRef.current.connectionState === "failed"
            ) {
                console.log("Peer connection disconnected or failed");
                peerConnectionRef.current.close();
                if (remoteStreamRef.current) {
                    remoteStreamRef.current.srcObject = null;
                }
                setPeerId("");
                isCallStarted = false;
                sessionStorage.setItem("isCallStarted", isCallStarted);
            }
        };

        peerConnectionRef.current.onsignalingstatechange = () => {
            console.log("Signaling state:", peerConnectionRef.current.signalingState);
        };

        stream?.getTracks().forEach((track) => {
            peerConnectionRef.current.addTrack(track, stream);
        });
    };

    // Automatically play the audio when the index changes or a new file is added
    useEffect(() => {
        if (transaltedAudioBufferRef.current.length > 0) {
            if (currentAudioIndex === null) {
                setCurrentAudioIndex(0); // Start playing from the first audio if none is currently playing
            } else if (localAudioStreamRef.current) {
                localAudioStreamRef.current.play(); // Play the current audio
            }
        }
    }, [currentAudioIndex]);

    useEffect(() => {

    }, [audioIndexCounter.current])

    const answerCall = async () => { 
        const answer = await peerConnectionRef.current.createAnswer();
        await peerConnectionRef.current.setLocalDescription(answer);
                    
        socket.emit("signal", {
            type: "answer",
            sdp: answer.sdp,
            to: peerId,
            targetLanguage: language,
        });

        setIsCallReceiving(false);
        setIsCallOnGoing(true);
        isCallStarted = true;
        sessionStorage.setItem("isCallStarted", isCallStarted);

        startRecording();
    };

    const declineCall = async () => { 
                    
        socket.emit("signal", {
            type: "decline",
            to: peerId,
        });

        setIsCallReceiving(false);
        setIsCallOnGoing(false);
        isCallStarted = false;
        sessionStorage.setItem("isCallStarted", isCallStarted);

    };

    const handleLanguageSelection = (selectedLanguage) => {
        setLanguage(selectedLanguage);
        // Send the selected language to the server
        console.log("Selected language is :", selectedLanguage);
        socket.emit("set-language", {
            id: socket.id,
            sourceLanguage: selectedLanguage,
        });
        socket.sourceLanguage = selectedLanguage;
    };

    const handleCall = async () => {
        
        if (!peerId) {
            alert("No peer to connect to")
            console.error("No peer to connect to");
            return;
        }
        setIsCallOnGoing(true);
        try {
            if (
                !peerConnectionRef.current ||
                peerConnectionRef.current.signalingState === "closed"
            ) {
                console.error("Peer connection is not initialized or is closed");
                initializePeerConnection(localStreamRef.current.srcObject);
            }
            const offer = await peerConnectionRef.current.createOffer();
            await peerConnectionRef.current.setLocalDescription(offer);
            console.log("Sending offer:", offer);
            socket.emit("signal", { type: "offer", sdp: offer.sdp, to: peerId });

            // isCallStarted = true;
            // sessionStorage.setItem("isCallStarted", isCallStarted);

            // startRecording();
        } catch (error) {
            console.error("Error creating offer:", error);
        }
    };

    const startRecording = async () => {
        isCallStarted = true;
        shouldProcessAudio = true;
        sessionStorage.setItem("shouldProcessAudio", shouldProcessAudio);
        sessionStorage.setItem("isCallStarted", isCallStarted);

        console.log(" in recording", isCallStarted);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            //if(localAudioStreamRef.current){
                localAudioStreamRef.current.srcObject = stream;
            //}
            audioRecorderRef.current = new MediaRecorder(stream);

            const audioSource =
                audioContextRef.current.createMediaStreamSource(stream);

            // analyserRef.current = audioContextRef.current.createAnalyser();
            // analyserRef.current.fftSize = 2048;
            const recordingprops = {
                numberOfChannels: 1,
                sampleRate: audioContextRef.current.sampleRate,
                maxFrameCount: audioContextRef.current.sampleRate * 1 / 10
            };
        
            // Load and register the AudioWorklet processor
            //await audioContext.current.audioWorklet.addModule('pcmProcessor.js');  // Load the processor script
            // Debug: Add logging to confirm loading of Audio Worklet
            try {
                await audioContextRef.current.audioWorklet.addModule('./worklets/recording-processor.js');
                console.log("worklet attached")
            } catch (error) {
                console.log(`Add module error ${error}`);
            }

            workletNode.current = new AudioWorkletNode(
                audioContextRef.current,
                'recording-processor',
                {
                  processorOptions: recordingprops,
                },
              );
            
              const destination = audioContextRef.current.createMediaStreamDestination();
            
              workletNode.current.port.postMessage({
                message: 'UPDATE_RECORDING_STATE',
                setRecording: true,
              });


            audioSource.connect(workletNode.current).connect(destination);
            
            workletNode.current.port.onmessageerror = (error) => {
                console.log(`Error receiving message from worklet ${error}`);
            };
                
          
            const audioDataIterator = pEvent.iterator(workletNode.current.port, 'message');
        
            const getAudioStream = async function* () {
                for await (const chunk of audioDataIterator) {
                    if (chunk.data.message === 'SHARE_RECORDING_BUFFER') {
                        const abuffer = pcmEncode(chunk.data.buffer[0]);
                        const audiodata = new Uint8Array(abuffer);
                        console.log(`processing chunk of size ${audiodata.length}`);
                        yield {
                            AudioEvent: {
                                AudioChunk: audiodata,
                            },
                        };
                    }
                }
            };

            const transcribeClient = new TranscribeStreamingClient({
                region: 'us-east-1',
                credentials: {
                    accessKeyId: "",
                    secretAccessKey: "",
                },
            });
            console.log("transcribeClient:::", transcribeClient)
    
            const command = new StartStreamTranscriptionCommand({
                LanguageCode: language,
                MediaEncoding: 'pcm',
                MediaSampleRateHertz: "48000",
                AudioStream: getAudioStream(),
            });

            const data = await transcribeClient.send(command);
            // console.log("Data::::", data)
            // console.log('Transcribe session established ', data.SessionId);

            if (data.TranscriptResultStream) {
                for await (const event of data.TranscriptResultStream) {
                    if (event?.TranscriptEvent?.Transcript) {
                        for (const result of event?.TranscriptEvent?.Transcript.Results || []) {
                            if (result?.Alternatives && result?.Alternatives[0].Items) {
                                let completeSentence = ``;
                                for (let i = 0; i < result?.Alternatives[0].Items?.length; i++) {
                                    completeSentence += ` ${result?.Alternatives[0].Items[i].Content}`;
                                }
                                // console.log("completeSentence:::", completeSentence)
                                // console.log("isPartial::::", result.IsPartial);
                                // console.log("resultID:::::", result.ResultId);
                                if(!result.IsPartial){
                                    setTranscribedText(transcribedText + "\n" + completeSentence)
                                }
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error("Error accessing microphone:", error);
        }
    };

    const pcmEncode = (input) => {
        const buffer = new ArrayBuffer(input.length * 2);
        const view = new DataView(buffer);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        }
        return buffer;
    };

    const stopRecording = () => {
        if (audioRecorderRef.current && isCallStarted) {
            console.log(" in stop recording");
            audioRecorderRef.current.stop();
        }
        shouldProcessAudio = false;
        sessionStorage.setItem("shouldProcessAudio", shouldProcessAudio);

        if (workletNode.current) {
            workletNode.current.port.postMessage({
            message: 'UPDATE_RECORDING_STATE',
            setRecording: false,
          });
          workletNode.current.port.close();
          workletNode.current.disconnect();
        } else {
          console.log('no media recorder available to stop');
        }
    };

    const handleFinalTranscript = (finalText) => {
        console.log("finalText:::", finalText)
        if(finalText){
            console.log("AIC Set:::", audioIndexCounter)
            socket.emit("transcripted-text", {transcription: finalText, audIndex: audioIndexCounter.current})
           // setAudioIndexCounter(audioIndexCounter + 1)
            audioIndexCounter.current += 1;
        }
    };

    const translateTextData = async () => { 
        console.log("in translate text******", textToTranslate)
        if(textToTranslate){
            socket.emit("transcripted-text", { transcription: textToTranslate, audIndex: audioIndexCounter.current });
           // setAudioIndexCounter(audioIndexCounter + 1)
            audioIndexCounter.current += 1;
            setTextToTranslate("")
        }
        
    };

    const handleTranslateTextChange = (event) =>{
        setTextToTranslate(event.target.value)
    }


    const handleEndCall = (emitEvent = true) => {
        setIsCallOnGoing(false);
        if (peerConnectionRef.current) {
            peerConnectionRef.current.close();
        }
        if (localStreamRef.current && localStreamRef.current.srcObject) {
            const tracks = localStreamRef.current.srcObject.getTracks();
            tracks.forEach((track) => track.stop());
            localStreamRef.current.srcObject = null;
        }
        if (remoteStreamRef.current && remoteStreamRef.current.srcObject) {
            remoteStreamRef.current.srcObject
                .getTracks()
                .forEach((track) => track.stop());
            remoteStreamRef.current.srcObject = null;
        }
        if (localAudioStreamRef.current && localAudioStreamRef.current.srcObject) {
            const tracks = localAudioStreamRef.current.srcObject.getTracks();
            tracks.forEach((track) => track.stop());
            localAudioStreamRef.current.srcObject = null;
        }
        
        stopRecording();

        isCallStarted = false;
        sessionStorage.setItem("isCallStarted", isCallStarted);

        setPeerId("");

        if (emitEvent) {
            socket.emit("end-call", { to: peerId, from: socket.id });
        }

        window.location.reload();
    };


    const toggleMute = () => {
        console.log('localAudioStreamRef.current:::', localAudioStreamRef.current)
        console.log('localStreamRef:::', localStreamRef)
        if (localAudioStreamRef.current && localAudioStreamRef.current.srcObject) {
            const stream = localAudioStreamRef.current.srcObject;
            stream
                .getAudioTracks()
                .forEach((track) => (track.enabled = !track.enabled));
            setIsMuted(!isMuted);
        }
    };


    const toggleVideo = () => {
        if (localStreamRef.current && localStreamRef.current.srcObject) {
            const stream = localStreamRef.current.srcObject;
            stream.getVideoTracks().forEach((track) => {
                track.enabled = !track.enabled;
                setIsVideoOff(!track.enabled);
            });
        }
    };


    return (
        <div className="call-container">
            <h2>Transsy 1.0</h2>
            <b>Preferred Language: </b><select
                onChange={(e) => handleLanguageSelection(e.target.value)}
                value={language}
            >
                <option value="select">--Select--</option>
                {/* <option value="zh-CN">Chinese, Simplified</option> */}
                {/* <option value="nl-NL">Dutch</option> */}
                <option value="en-AU">English (Australian)</option>
                <option value="en-GB">English (British)</option>
                <option value="en-NZ">English (New Zealand)</option>
                <option value="en-US">English (US)</option>
                <option value="fr-FR">French</option>
                <option value="fr-CA">French (Canadian)</option>
                <option value="de-DE">German</option>
                <option value="it-IT">Italian</option>
                <option value="ja-JP">Japanese</option>
                {/* <option value="ko-KR">Korean</option> */}
                <option value="pt-BR">Portuguese (Brazilian)</option>
                <option value="es-ES">Spanish (European)</option>
                <option value="es-US">Spanish (US)</option>

                {/* <option value="select">--Select--</option>
                <option value="arb">Arabic</option>
                <option value="ar-AE">Arabic (Gulf)</option>
                <option value="ca-ES">Catalan</option>
                <option value="yue-CN">Chinese (Cantonese)</option>
                <option value="cmn-CN">Chinese (Mandarin)</option>
                <option value="da-DK">Danish</option>
                <option value="nl-BE">Dutch (Belgian)</option>
                <option value="nl-NL">Dutch</option>
                <option value="en-AU">English (Australian)</option>
                <option value="en-GB">English (British)</option>
                <option value="en-IN">English (Indian)</option>
                <option value="en-NZ">English (New Zealand)</option>
                <option value="en-ZA">English (South African)</option>
                <option value="en-US">English (US)</option>
                <option value="en-GB-WLS">English (Welsh)</option>
                <option value="fi-FI">Finnish</option>
                <option value="fr-FR">French</option>
                <option value="fr-BE">French (Belgian)</option>
                <option value="fr-CA">French (Canadian)</option>
                <option value="hi-IN">Hindi</option>
                <option value="de-DE">German</option>
                <option value="de-AT">German (Austrian)</option>
                <option value="is-IS">Icelandic</option>
                <option value="it-IT">Italian</option>
                <option value="ja-JP">Japanese</option>
                <option value="ko-KR">Korean</option>
                <option value="nb-NO">Norwegian</option>
                <option value="pl-PL">Polish</option>
                <option value="pt-BR">Portuguese (Brazilian)</option>
                <option value="pt-PT">Portuguese (European)</option>
                <option value="ro-RO">Romanian</option>
                <option value="ru-RU">Russian</option>
                <option value="es-ES">Spanish (European)</option>
                <option value="es-MX">Spanish (Mexican)</option>
                <option value="es-US">Spanish (US)</option>
                <option value="sv-SE">Swedish</option>
                <option value="tr-TR">Turkish</option>
                <option value="cy-GB">Welsh</option> */}

                {/* <option value="ab-GE">Abkhaz</option>
                <option value="af-ZA">Afrikaans</option>
                <option value="ar-AE">Arabic, Gulf</option>
                <option value="ar-SA">Arabic, Modern Standard</option>
                <option value="hy-AM">Armenian</option>
                <option value="ast-ES">Asturian</option>
                <option value="az-AZ">Azerbaijani</option>
                <option value="ba-RU">Bashkir</option>
                <option value="eu-ES">Basque</option>
                <option value="be-BY">Belarusian</option>
                <option value="bn-IN">Bengali</option>
                <option value="bs-BA">Bosnian</option>
                <option value="bg-BG">Bulgarian</option>
                <option value="ca-ES">Catalan</option>
                <option value="ckb-IR">Central Kurdish, Iran</option>
                <option value="ckb-IQ">Central Kurdish, Iraq</option>
                <option value="zh-CN">Chinese, Simplified</option>
                <option value="zh-TW">Chinese, Traditional</option>
                <option value="hr-HR">Croatian</option>
                <option value="cs-CZ">Czech</option>
                <option value="da-DK">Danish</option>
                <option value="nl-NL">Dutch</option>
                <option value="en-AU">English, Australian</option>
                <option value="en-GB">English, British</option>
                <option value="en-IN">English, Indian</option>
                <option value="en-IE">English, Irish</option>
                <option value="en-NZ">English, New Zealand</option>
                <option value="en-AB">English, Scottish</option>
                <option value="en-ZA">English, South African</option>
                <option value="en-US">English, US</option>
                <option value="en-WL">English, Welsh</option>
                <option value="et-ET">Estonian</option>
                <option value="fa-IR">Farsi</option>
                <option value="fi-FI">Finnish</option>
                <option value="fr-FR">French</option>
                <option value="fr-CA">French, Canadian</option>
                <option value="gl-ES">Galician</option>
                <option value="ka-GE">Georgian</option>
                <option value="de-DE">German</option>
                <option value="de-CH">German, Swiss</option>
                <option value="el-GR">Greek</option>
                <option value="gu-IN">Gujarati</option>
                <option value="ha-NG">Hausa</option>
                <option value="he-IL">Hebrew</option>
                <option value="hi-IN">Hindi, Indian</option>
                <option value="hu-HU">Hungarian</option>
                <option value="is-IS">Icelandic</option>
                <option value="id-ID">Indonesian</option>
                <option value="it-IT">Italian</option>
                <option value="ja-JP">Japanese</option>
                <option value="kab-DZ">Kabyle</option>
                <option value="kn-IN">Kannada</option>
                <option value="kk-KZ">Kazakh</option>
                <option value="rw-RW">Kinyarwanda</option>
                <option value="ko-KR">Korean</option>
                <option value="ky-KG">Kyrgyz</option>
                <option value="lv-LV">Latvian</option>
                <option value="lt-LT">Lithuanian</option>
                <option value="lg-IN">Luganda</option>
                <option value="mk-MK">Macedonian</option>
                <option value="ms-MY">Malay</option>
                <option value="ml-IN">Malayalam</option>
                <option value="mt-MT">Maltese</option>
                <option value="mr-IN">Marathi</option>
                <option value="mhr-RU">Meadow Mari</option>
                <option value="mn-MN">Mongolian</option>
                <option value="no-NO">Norwegian Bokmål</option>
                <option value="or-IN">Odia/Oriya</option>
                <option value="ps-AF">Pashto</option>
                <option value="pl-PL">Polish</option>
                <option value="pt-PT">Portuguese</option>
                <option value="pt-BR">Portuguese, Brazilian</option>
                <option value="pa-IN">Punjabi</option>
                <option value="ro-RO">Romanian</option>
                <option value="ru-RU">Russian</option>
                <option value="sr-RS">Serbian</option>
                <option value="si-LK">Sinhala</option>
                <option value="sk-SK">Slovak</option>
                <option value="sl-SI">Slovenian</option>
                <option value="so-SO">Somali</option>
                <option value="es-ES">Spanish</option>
                <option value="es-US">Spanish, US</option>
                <option value="su-ID">Sundanese</option>
                <option value="sw-KE">Swahili, Kenya</option>
                <option value="sw-BI">Swahili, Burundi</option>
                <option value="sw-RW">Swahili, Rwanda</option>
                <option value="sw-TZ">Swahili, Tanzania</option>
                <option value="sw-UG">Swahili, Uganda</option>
                <option value="sv-SE">Swedish</option>
                <option value="tl-PH">Tagalog/Filipino</option>
                <option value="ta-IN">Tamil</option>
                <option value="tt-RU">Tatar</option>
                <option value="te-IN">Telugu</option>
                <option value="th-TH">Thai</option>
                <option value="tr-TR">Turkish</option>
                <option value="uk-UA">Ukrainian</option>
                <option value="ug-CN">Uyghur</option>
                <option value="uz-UZ">Uzbek</option>
                <option value="vi-VN">Vietnamese</option>
                <option value="cy-WL">Welsh</option>
                <option value="wo-SN">Wolof</option>
                <option value="zu-ZA">Zulu</option> */}

                {/* Add more languages as needed */}
            </select>
            <div className="video-container">
                <video ref={localStreamRef} autoPlay playsInline />
                <video ref={remoteStreamRef} autoPlay playsInline />
                <audio ref={localAudioStreamRef} style={{display:"none"}} 
                    />
            </div>
            <div className="button-container">
                <button
                    onClick={handleCall}
                    disabled={isCallOnGoing}
                    style={{ backgroundColor: isCallOnGoing ? "gray" : "green" }}
                >
                    Start Call
                </button>
                <button
                    onClick={toggleMute}
                    style={{ backgroundColor: isMuted ? "red" : "green" }}
                >
                    {isMuted ? "Unmute" : "Mute"}
                </button>
                <button
                    onClick={toggleVideo}
                    style={{ backgroundColor: isVideoOff ? "red" : "green" }}
                >
                    {isVideoOff ? "Turn Video On" : "Turn Video Off"}
                </button>
                <button
                    onClick={() => handleEndCall(true)}
                    disabled={!isCallOnGoing}
                    style={{ backgroundColor: isCallOnGoing ? "red" : "gray" }}
                >
                    End Call
                </button>

                <button className="answer-button"
                    disabled={!isAudioProcessing}
                    style={{
                        backgroundColor: isAudioProcessing ? "blue" : "gray",
                        display: isAudioProcessing ? "block" : "none",
                    }}
                >
                    Processing Audio...
                </button>
                <button
                    onClick={answerCall}
                    disabled={!isCallReceiving}
                    style={{
                        backgroundColor: isCallReceiving ? "green" : "gray",
                        display: isCallReceiving ? "block" : "none",
                    }}
                >
                    Answer
                </button>
                <button
                    onClick={declineCall}
                    disabled={!isCallReceiving}
                    style={{
                        backgroundColor: isCallReceiving ? "red" : "gray",
                        display: isCallReceiving ? "block" : "none",
                    }}
                >
                    Decline
                </button>
            </div>
            
            <div className="answer-button-container">
                <input type="text" className="translate-ta"
                    onChange={handleTranslateTextChange}
                    placeholder="Text to translate"
                    style={{
                        display: isCallOnGoing ? "block" : "none",
                    }}
                    value={textToTranslate}
                />
                <button className="translate-button"
                    
                    onClick={translateTextData}
                    disabled={!isCallOnGoing}
                    style={{
                        backgroundColor: "#00a3ff",
                        display: isCallOnGoing ? "block" : "none",
                    }}
                >
                    Translate
                </button>
            </div>
            <div className="transcription-container">
                <h3>Transcribed Text:</h3>
                <p>{transcribedText}</p>
            </div>
        </div>
    );
};

export default CallAwsStreaming;
