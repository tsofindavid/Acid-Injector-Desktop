var fileName = undefined;

function bigEndian() {
    // Returns TRUE for big endian, FALSE for little endian
      var arrayBuffer = new ArrayBuffer(2);
      var uint8Array = new Uint8Array(arrayBuffer);
      var uint16array = new Uint16Array(arrayBuffer);
      uint8Array[0] = 0xAA; // set first byte
      uint8Array[1] = 0xBB; // set second byte
      if(uint16array[0] === 0xBBAA) return false; // little endian
      if(uint16array[0] === 0xAABB) return true; // big endian
      else throw new Error("Something crazy just happened");
 }

 function swap16(val) {
      return ((val & 0xFF) << 8)
             | ((val >> 8) & 0xFF);
 }

// Converts a uint8 decimal value to a 0-padded hex byte string, or converts
// a Uint8Array to a string of 0-padded hex bytes.
function d2h(d) {
    var s = "";

    if(typeof(d) == 'object')
    {
        // treat it as a Uint8Array
        for(var i = 0; i < d.length; i++)
        {
            var b = (+d[i]).toString(16);
            if(b.length < 2) {
                b = '0' + b;
            }
            s += b;
        }
    }
    else
    {
        s = (+d).toString(16);
        if(s.length < 2) {
            s = '0' + s;
        }
    }
    
    return s;
}

function d2b(d) {
    var s = "";

    if(typeof(d) == 'object')
    {
        // treat it as a Uint8Array
        for(var i = 0; i < d.length; i++)
        {
            var b = (+d[i]).toString(2).padStart(8, '0');
            s += b;
            s += ' ';
        }        
    }
    else
    {
        s = (+d).toString(2).padStart(8, '0');
    }

    return s;
}

var userSequenceLength = 16;

var outBytes = new Uint8Array(146);

var midiIsValid = false;
var ouptutIsReady = false;

var user_tripletMode = false;

document.getElementById("btnGenerate").addEventListener("click", generateOutput);
document.getElementById("sysexGenerate").addEventListener("click", generateSysex);

document.getElementById("user_sequencelength").addEventListener('change', function() {
    userSequenceLength = this.value;
    console.log(userSequenceLength);
})

// Force that damn triplet checkbox to false
document.getElementById("user_triplet").addEventListener("click", function(){
    user_tripletMode = document.getElementById("user_triplet").checked;
})

document.querySelector('input').addEventListener('change', function() {
    var reader = new FileReader();
    reader.onload = function(info) {
        var arrayBuffer = this.result;
        var array = new Uint8Array(arrayBuffer);

        //var binaryString = String.fromCharCode.apply(null, array);
        //console.log(binaryString);        

        // I think/hope that all file and track header offsets below are fixed
        // in our particular case

        // Header
        var fileHeader = array.subarray(0, 4); // should be 'MThd'
        var formatType = array.subarray(8,10); // should be 00 00
        var trackChunks = array.subarray(10, 12); // should be 00 01
        var divisionValue = array.subarray(12, 14); // PPQN
        // Track chunk
        var trackHeader = array.subarray(14, 18); // should be 'MTrk'
        var trackDataSize = array.subarray(18, 22); // length of data from next byte onwards
        
        var outdiv = document.getElementById('output');
        outdiv.innerHTML = '';

        if(fileHeader.toString() == '77,84,104,100')
        {
            midiIsValid = true;
            outdiv.appendChild(document.createTextNode('MIDI header is valid'));
            outdiv.appendChild(document.createElement('br'));
        }
        else
        {
            midiIsValid = false;
            outdiv.appendChild(document.createTextNode('Invalid MIDI file header'));
            outdiv.appendChild(document.createElement('br'));
        }

        if(formatType.toString() == '0,0')
        {
            outdiv.appendChild(document.createTextNode('Format type is 0'));
            outdiv.appendChild(document.createElement('br'));
        }
        else
        {
            midiIsValid = false;
            outdiv.appendChild(document.createTextNode('Invalid MIDI file format type (should be type 0)'));
            outdiv.appendChild(document.createElement('br'));
        }

        if(trackChunks.toString() == '0,1')
        {
            outdiv.appendChild(document.createTextNode('Track count: 1'));
            outdiv.appendChild(document.createElement('br'));

            outdiv.appendChild(document.createTextNode('PPQN: ' + divisionValue[1].toString()));
            outdiv.appendChild(document.createElement('br'));

            outdiv.appendChild(document.createTextNode('Everything\'s probably fine. Check you\'re happy with the Sequence Length, then hit Save .seq/.syx'));
            outdiv.appendChild(document.createElement('br'));
        }
        else
        {
            midiIsValid = false;
            outdiv.appendChild(document.createTextNode('Invalid MIDI track count (should be 1)'));
            outdiv.appendChild(document.createElement('br'));
        }

        if(midiIsValid == false)
        {
            return;
        }

        // If those all check out, step through and keep count.
        var offset = 22;

        // We expect a timestamp of 00 then FF 03 for a Track Name meta event.
        var tracknameMeta = array.subarray(offset, offset+3);
        
        if(d2h(tracknameMeta) == "00ff03")
        {   
            var tracknameLength = 0;
            tracknameLength = array[offset+3];

            var trackName = array.subarray(offset+4, offset+4+tracknameLength);
            offset += 4 + tracknameLength;
        }
        
        // We're interested in bytes of 0x80 or greater. Channel events go
        // from 0x8N to 0xEN, where N is the channel number (0-F).
        // Meta events all start with FF, and the only ones we expect to see are
        // FF 03 LL [TEXT] (Track Name of length LL),
        // FF 58 04 NN MM LL TT (Time Signature) and
        // FF 2F 00 (End of Track, required as last event in a MTrk chunk)
        //
        // Each time we find a Channel/Meta event, we should read the previous
        // byte to get its Delta Time. 
        
        var totalTime = 0; // in ticks

        // Sequencer PPQN, usually 96 for Ableton Live MIDI clips
        var ticksPerQuarterNote = divisionValue[1];

        // To be obtained from the time signature meta event(s)
        var timeSignatureNumerator = 0;
        var timeSignatureDenominator = 0;
        var clocksPerMetronomePulse = 0;
        var thirtysecondNotesPerBeat = 0;
        var quarterNotesPerBeat = 0;
        var beatsPerMinute = 120; // Ableton doesn't put tempo in a clip unless you've specifically added a tempo change meta event; 120 is the MIDI standard default
        
        
        // We'll fill this in our time-calc loop, then add noteOns and noteOffs to it later 
        // to help us detect  tied notes
        var timestampEvents = {};

        // We'll loop through once to get the total time in ticks, and calculate
        // how many ticks each step lasts, and also check some meta events,
        // then we'll loop again to create an array of note objects and timings.
        for(var i = offset; i < array.length; i++)
        {
            if(array[i] >= 0x80)
            {           

                var timedelta = array[i-1]; // in ticks
                totalTime += timedelta;
                if(array[i] === 0x90)
                {
                    //console.log("Note Timestamp found: " + timedelta + " total : " + totalTime);
                }
                
                //console.log("Event found: " + d2h(array[i]) + " with time delta " + timedelta + " totalTime: " + totalTime + " offset: " + i);
                
                // Push a new Timestamp Event
                timestampEvents[totalTime] = {
                    "timestamp": totalTime,
                    "noteOff": 0,
                    "noteOn": 0,
                    "step": 0
                };

                // It's important to know these events exist, but we don't care 
                // about them. Although we might care about Time Signature...
                if(array[i] == 0xff)
                {
                    // Meta event
                    if(array[i+1] == 0x03)
                    {                            
                        // Found Track Name
                    }
                    else if(array[i+1] == 0x58)
                    {
                        // Found Time Signature
                        
                        timeSignatureNumerator = array[i+3];

                        timeSignatureDenominator = array[i+4];

                        if(timeSignatureDenominator == 1)
                        {
                            quarterNotesPerBeat = 4;
                        }
                        if(timeSignatureDenominator == 2)
                        {
                            quarterNotesPerBeat = 2;
                        }
                        if(timeSignatureDenominator == 4)
                        {
                            quarterNotesPerBeat = 1;
                        }
                        if(timeSignatureDenominator == 8)
                        {
                            quarterNotesPerBeat = 0.5;
                        }
                        if(timeSignatureDenominator == 16)
                        {
                            quarterNotesPerBeat = 0.25;
                        }
                        // There's another one that I don't even slightly understand right now and can't be arsed to figure out

                        clocksPerMetronomePulse = array[i+5];
                        
                        thirtysecondNotesPerBeat = array[i+6]; 
                        
                    }
                    else if(array[i+1] == 0x2f)
                    {
                        // Found End of Track
                    }
                }

            }
        }
        
        // Le sigh. How MIDI time signature meta messages work:
        // 0xff 0x58 0x04 - this is a MIDI time sig meta event announcing itself to have 4 bytes of data
        //                0x04 - numerator
        //                      0x02 - denominator: 2 should be raised to the power of denominator to obtain time sig denominator, e.g. 2^2 = 4
        //                          0x24 - metronome pulse: will click once every n (in this case 36) MIDI clocks
        //                               0x08 - there are 8 demisemiquavers (32nd notes) per beat
        // So our step duration is our bar duration in MIDI clocks (ticks?) divided by 16 steps
        // 
        
        // Nevertheless, I think this is how we should be doing it.
        stepDuration = (ticksPerQuarterNote * 4) / 16; // should equal 24
        console.log("stepDuration: " + stepDuration + " totalTime: " + totalTime);


        console.log(timestampEvents);
        
        // We're looking to fill the following arrays (all max length 16):
        //      Pitch data
        //      Accent flags
        //      Slide flags - slide is effectively portamento, and in MIDI is represented by the previous note overlapping the current note; the current note is 'slid' to
        //      Ties - a tied note makes consecutive non-rest steps with the same pitch behave as one long note, ie no retrigger
        //      Rests - all steps are rests by default, unless unset (bit set to 0) to make that step audible
        // and find the following values:
        //      Triplet flag - actually not sure wtf we do about this
        //      Sequence length (between 1 and 16)
        //
        // Pitch data is easy - look at Note On events
        // Accent flags are also easy - look at Note On events with max velocity
        // Slide flags are set if there's a Note On before the previous Note On has had a corresponding Note Off
        // Triplet flag - setting this is easy, but under which conditions? Does it have any meaning beyond limiting pattern length to 15?
        // Sequence length - we should maybe make this configurable on the UI, to be honest
        // Ties and Rests...gnarly bitwise stuff ahoy.


        

        var pitchSteps = [];                

        for(var d = 0; d < 16; d++)
        {
            pitchSteps.push({
                //"pitch": 0x18,
                "pitch": 0x00, // If any pitch is 0x00 by the time we're writing our pitches, ignore it and shuffle everything up; pad the end with 0x18
                "timestamp":0,
                "step": d,
                "duration":0,
                "rest": true,
                "tied": false,
                "slid": false,
                "accented": false
            });

        }        

        // Use this to detect Slides
        var hungNoteValue = 0;        

        // Four bytes each for ties and rests that we'll manipulate later            
        var restMap = new Uint8Array([0b00001111, 0b00001111, 0b00001111, 0b00001111]);
        var tieMap = new Uint8Array([0b00001111, 0b00001111, 0b00001111, 0b00001111]);
                
        

        var elapsedTime = 0; // in ticks
        var currentstep = 0;

        var elapsedTicksThisStep = 0;

        // Start from the current offset position (after the header etc.) so we're only
        // looping the Track chunk
        for(var i = offset; i < array.length; i++)
        {            

            // This gives us only Notes or Meta Events
            if(array[i] >= 0x80) 
            {
                                            
                // Doesn't matter what the event is, we should increment elapsedTime by the event's delta.
                // NOTE: this isn't robust enough to work for sequences with enormous gaps between notes.
                // So don't be surprised when it doesn't. 1-byte delta times only pls.
                 elapsedTime += array[i-1];

                // Current step is used for our own temporary array indexing, and then to calculate the rest/tie bitwise stuff
                currentstep = Math.round((elapsedTime) / stepDuration);       
                
                /*
                elapsedTicksThisStep+= array[i-1];
                if(elapsedTicksThisStep > stepDuration)
                {
                    currentstep++;
                    elapsedTicksThisStep = 0;
                }                
                */
               
                

                if(currentstep > 15)
                {
                    break;
                }
                
                timestampEvents[elapsedTime].currentstep = currentstep;

                if(currentstep == 11)
                {
                    console.log("current step is 11. noteon: " + timestampEvents[elapsedTime].noteOn + "eventsarray.timestamp : " + timestampEvents[elapsedTime].timestamp);
                }

                // This gives us only notes
                if(array[i] <= 0xEF)
                {
                    var noteMIDI = array[i+1];
                    var noteTD3 = noteMIDI - 12;
                    var velo = array[i+2];

                    // Found NoteOn
                    if((array[i] >= 0x90 && array[i] < 0xA0))
                    {
                        console.log("Found a Note ON with value " + noteTD3 + " with velo " + velo + " at index " + i + ", step " + currentstep) ;                        
                        
                        pitchSteps[currentstep].pitch = noteTD3;
                        pitchSteps[currentstep].timestamp = elapsedTime;
                        pitchSteps[currentstep].duration = 0;
                        pitchSteps[currentstep].step = currentstep;
                        pitchSteps[currentstep].rest = false;
                                    
                        timestampEvents[elapsedTime].noteOn = noteTD3;

                        if(velo >= 0x64)
                        {
                            pitchSteps[currentstep].accented = true;
                        }                        

                        if(currentstep > 0)
                        {
                            if(hungNoteValue > 0)
                            {
                                // hungNoteValue should be reset to 0 by noteoff. 
                                // If it's greater than, the note is slid. Slided. Slidden. Slidulterated.
                                // Actually, the previous step gets the slide flag, so this note is slid TO.
                                pitchSteps[currentstep-1].slid = true;
                            }
                        }
                        

                        hungNoteValue = noteTD3;

                    }

                    // Found NoteOff
                    if(array[i] >= 0x80 && array[i] < 0x90)
                    {
                        //console.log("Found a Note OFF with value " + noteTD3 + " with velo " + velo + " at timestamp " + elapsedTime + ", step " + currentstep) ;

                        timestampEvents[elapsedTime].noteOff = noteTD3;

                        // Work back through the existing notes until we find a match, then calculate that note's duration in ticks                        
                        var n = currentstep;
                        while(n--)
                        {
                            if(pitchSteps[n] !== undefined)
                            {
                                if(pitchSteps[n].hasOwnProperty('pitch'))
                                {
                                    if (pitchSteps[n].pitch == noteTD3 && pitchSteps[n].step != currentstep)
                                    {                                        
                                        pitchSteps[n].duration = elapsedTime - pitchSteps[n].timestamp;
                                        //console.log("Step " + currentstep +  ":found a matching NoteOn for NoteOff " + noteTD3 + " at step " + currentstep + ", setting duration " + pitchSteps[n].duration + ". Elapsed: " + elapsedTime);
                                        break;
                                    }
                                    
                                }
                            }
                        }

                        // If this noteoff corresponds to the current hungNoteValue, reset it to zero.
                        // If not, the note will hang and we'll set a slide flag on the next loop.
                        if(hungNoteValue == noteTD3)
                        {
                            hungNoteValue = 0;                            
                        }
                    }

                }

            }


        }

     
        // Detect tied notes
        for(var p = 0; p < pitchSteps.length; p++)
        {
            if(pitchSteps[p].hasOwnProperty('duration'))
            {
                // On the TD-3, setting a tie step pushes the other notes along.
                // The first step can't be a tie, or there'd never be a Note On.
                // There's no audible difference on the TD-3 between a tied note and a slide to the same note
                if(pitchSteps[p].duration > stepDuration)
                {
                    //console.log("Found a tied note at pitchStep index " + p + ": note duration was longer than a full step");
                }
            }
        }

        //console.log(timestampEvents);

        // We check for tied notes by checking if one timestamp (ie step boundary) contains a NoteOff AND a NoteOn for the same note - 
        // this means the old note should be treated as slid and the new note as slid-TO; the old note gets the slide flag set.
        for(let key in timestampEvents)
        {
            var cstep = timestampEvents[key].currentstep;

            if(timestampEvents[key].noteOff == timestampEvents[key].noteOn && cstep > 0 && cstep < 16)
            {
                //console.log("Found a tie at step " + cstep);
                // Jesus, after all that hassle, it's just a slide
                pitchSteps[cstep-1].slid = true;                
                
            }            
        }

     
        

        // Some more updates for the user-facing output could be added here
        var activePitchCount = 0;
        var accentCount = 0;
        var slideCount = 0;
        for(var s = 0; s < pitchSteps.length; s++)
        {
            if(pitchSteps[s].pitch > 0x00)
            {
                activePitchCount++;
                if(pitchSteps[s].accented)
                {
                    accentCount++;
                }
                if(pitchSteps[s].slid)
                {
                    slideCount++;
                }
            }
        }
        outdiv.appendChild(document.createTextNode('Active pitch steps: ' + activePitchCount));
        outdiv.appendChild(document.createElement('br'));

        outdiv.appendChild(document.createTextNode('Accented notes: ' + accentCount));
        outdiv.appendChild(document.createElement('br'));

        outdiv.appendChild(document.createTextNode('Slid notes: ' + slideCount));
        outdiv.appendChild(document.createElement('br'));

        // Prepare the output file binary
        // Reset the array
        outBytes = new Uint8Array(110);
        
        var writeOffset = 0;

        // Write the pitches

        // This STILL isn't right: we may need to remove tied notes (ie the note after the slide),
        // which means not doing all this in sequence and writing to fixed offsets instead.
        // 
        
        var pitchWriteCounter = 0;

        for(var i = 0; i < 16; i++)
        {            
            if(pitchSteps[i] !== undefined)
            {
                // Only write if pitch is greater than 0x00 (ie if it's ever been set)
                if(pitchSteps[i].hasOwnProperty('pitch') && pitchSteps[i].pitch > 0x00)
                {
                    // 0x18 is MIDI C1 (decimal 24), and C2 to the TD-3.
                    // Sting generates out of range notes. It would be nice if it didn't...
                    // Maybe some other clones supported extended range? 
                    // Should we clamp them, set them to 0x18, or ignore them?
                    // Whatever we do, we need to do it before we set the pattern bitmask
                    var thispitch = d2h(pitchSteps[i].pitch);
                    var msb = parseInt(thispitch.charAt(0), 16);
                    var lsb = parseInt(thispitch.charAt(1), 16);
                    
                    outBytes[writeOffset] = msb;
                    outBytes[writeOffset+1] = lsb;
                    writeOffset += 2;

                    // Use this to check how many valid pitches were entered into the pool so we can pad it afterwards if necessary
                    pitchWriteCounter++; 
                    
                    //console.log("Duration: " + pitchSteps[i].duration);
                }
                
                
            }            
        }

        // The 303 decouples its 'pool' of notes from its timing data (hence Pitch Mode and Time Mode on the hardware),
        // which means that we can't have empty gaps in the pitch data where we think there should be empty gaps. No 
        // whitespace, basically. The sequencer reads through the timing data and looks for the next note every time there's
        // a non-rest step (and stops looking for notes if there's a tie). That's why we only added pitch bytes where
        // a genuine pitch had occurred, and why we now pad the remaining pitch bytes with the 0x01 0x08 default pitch.        
        while(pitchWriteCounter < 16)
        {
            outBytes[writeOffset] = 0x01;
            outBytes[writeOffset+1] = 0x08;
            writeOffset += 2;
            pitchWriteCounter++;
        }

        // Write the accent flags 
        pitchWriteCounter = 0; // re-use this
        for(var i = 0; i < 16; i++)
        {
            if(pitchSteps[i].pitch > 0x00)
            {
                if(pitchSteps[i].accented)
                {
                    outBytes[writeOffset] = 0x00;
                    outBytes[writeOffset+1] = 0x01;
                    writeOffset += 2;

                    pitchWriteCounter++;
                }
                else
                {
                    outBytes[writeOffset] = 0x00;
                    outBytes[writeOffset+1] = 0x00;
                    writeOffset += 2;

                    pitchWriteCounter++;
                }
                
            }
        }

        // Pad the remainder of the accent flag chunk        
        while(pitchWriteCounter < 16)
        {
            outBytes[writeOffset] = 0x00;
            outBytes[writeOffset+1] = 0x00;
            writeOffset += 2;
            pitchWriteCounter++;
        }

        // Write the slide flags 
        pitchWriteCounter = 0; // re-use this
        for(var i = 0; i < 16; i++)
        {
            if(pitchSteps[i].pitch > 0x00)
            {
                if(pitchSteps[i].slid)
                {
                    outBytes[writeOffset] = 0x00;
                    outBytes[writeOffset+1] = 0x01;
                    writeOffset += 2;

                    pitchWriteCounter++;
                }
                else
                {
                    outBytes[writeOffset] = 0x00;
                    outBytes[writeOffset+1] = 0x00;
                    writeOffset += 2;

                    pitchWriteCounter++;
                }
                
            }
        }

        // Pad the remainder of the slide flag chunk
        while(pitchWriteCounter < 16)
        {
            outBytes[writeOffset] = 0x00;
            outBytes[writeOffset+1] = 0x00;
            writeOffset += 2;
            pitchWriteCounter++;
        }
        

        // Write the triplet flag (2 bytes)
        outBytes[writeOffset] = 0x00;
        if(user_tripletMode)
        {
            outBytes[writeOffset+1] = 0x01;
        }
        else
        {
            outBytes[writeOffset+1] = 0x00;
        }        
        writeOffset += 2;

        // write offset 133

        // Write the sequence length
        if(userSequenceLength == 16)
        {
            outBytes[writeOffset] = 0x01;
            outBytes[writeOffset+1] = 0x00;
            writeOffset += 2;
        }
        else
        {
            outBytes[writeOffset] = 0x00;
            outBytes[writeOffset+1] = userSequenceLength;
            writeOffset += 2;
        }
        
        // 2 bytes of padding
        writeOffset += 2;


        for( var t = 0; t < 16; t++)
        {
            var maskbyte = 0b00000001;

            if(pitchSteps[t].tied)
            {
                if(t < 4)
            {
                tieMap[1] |= ~(maskbyte << t);
            }
            else if (t >= 4 && t < 8)
            {
                tieMap[0] |= ~(maskbyte << (t - 4));
            }
            else if (t >= 8 && t < 12)
            {
                tieMap[3] |= ~(maskbyte << (t - 8));
            }
            else if ( t >= 12 && t < 16)
            {
                tieMap[2] |= ~(maskbyte << (t - 12));
            }
            }
            
        }

        // Write the ties
        outBytes[writeOffset] = tieMap[0];
        outBytes[writeOffset+1] = tieMap[1];
        outBytes[writeOffset+2] = tieMap[2];
        outBytes[writeOffset+3] = tieMap[3];
        writeOffset += 4;

        console.log(d2h(tieMap));

        // Work out the rests
        for(var r = 0; r < 16; r++)
        {
            var maskbyte = new Uint8Array([0b00000001]);        
            var maskbyte = 0b00000001; 

            if(!pitchSteps[r].rest)
            {
                if(r < 4)
                {     
                    //console.log("maskbyte: " + d2b(maskbyte<< currentstep) + " step: " + currentstep);
                    restMap[1] &= ~(maskbyte << r);                                
                }
                else if(r >= 4 && r < 8)
                {                                
                    restMap[0] &= ~(maskbyte << (r - 4));       
                }
                else if(r >= 8 && r < 12)
                {
                    restMap[3] &= ~(maskbyte << (r - 8));       
                }
                else if(r >= 12 && r < 16)
                {                                                                
                    restMap[2] &= ~(maskbyte << (r - 12));       
                }
            }
            
        }

        // Write the rests
        outBytes[writeOffset] = restMap[0];
        outBytes[writeOffset+1] = restMap[1];
        outBytes[writeOffset+2] = restMap[2];
        outBytes[writeOffset+3] = restMap[3];
        writeOffset += 4;
                
        outputIsReady = true;
           
        console.log("Pitch Steps:");
        console.log(pitchSteps);
        console.log("restMap (binary then hex):");
        console.log(d2b(restMap));
        console.log(d2h(restMap));

    }

    reader.readAsArrayBuffer(this.files[0]);
    fileName = this.files[0].name

});

// Save the file
var saveOutBytes = (function() {
    var a = document.createElement('a');
    document.body.appendChild(a);
    a.style = "display: none";
    return function (data, name) {
        var blob = new Blob(data, {type: "octet/stream"}),
            url = window.URL.createObjectURL(blob);
        a.href = url;
        a.download = name;
        a.click();
        window.URL.revokeObjectURL(url);
    };
}());

function checkInput()
{
    console.log("clicked");
    var file = document.getElementById("fileinput").files[0];

    document.getElementById("output").innerText = "done";
    
}

function generateOutput()
{
    // Prepare the output file binary
    // Reset the array
    seqHeader = new Uint8Array([0x23, 0x98, 0x54, 0x76, 0x00, 0x00, 0x00, 0x08, 0x00, 0x54, 0x00, 0x44, 0x00, 0x2D, 0x00, 0x33, 0x00, 0x00, 0x00, 0x0A, 0x00, 0x31, 0x00, 0x2E, 0x00, 0x33, 0x00, 0x2E, 0x00, 0x37, 0x00, 0x00, 0x00, 0x70, 0x00, 0x00]);
    // outBytes should be 110 bytes long

    var finalBytes = new Uint8Array(seqHeader.length + outBytes.length);
    finalBytes.set(seqHeader, 0);
    finalBytes.set(outBytes, seqHeader.length);

    if(midiIsValid && outputIsReady)
    {
        saveOutBytes([finalBytes], `${fileName.split('.')[0]}.seq`);
    }    
}

function generateSysex()
{
   // Prepare the output file binary
    // sysex start byte, standard header (7 bytes), pattern group 0-3, patt section 0-7 (A) 9-15 (B), padding (2 bytes)
    syxHeader = new Uint8Array([0xF0, 0x00, 0x20, 0x32, 0x00, 0x01, 0x0A, 0x78, document.getElementById('user_patterngroup').value, document.getElementById('user_patternslot').value, 0x00, 0x00]);        

    // outBytes should be 110 bytes long. Add a byte at the end to end the sysex message (F7)
    var finalBytes = new Uint8Array(syxHeader.length + outBytes.length + 1);
    finalBytes.set(syxHeader, 0);
    finalBytes.set(outBytes, syxHeader.length);
    // sysex message end byte
    finalBytes[finalBytes.length -1] = 0xF7;
    if(midiIsValid && outputIsReady)
    {
        saveOutBytes([finalBytes], `${fileName.split('.')[0]}.syx`);
    }
}