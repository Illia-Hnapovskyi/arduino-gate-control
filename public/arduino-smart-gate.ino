#include <Servo.h>

// ============================================================
// ARDUINO GATE + RADAR + MUSIC + DHT11 + JOYSTICK GAME
// Старі підключення залишаються без змін:
//   SG90 signal  -> D9
//   HC-SR04 TRIG -> D7
//   HC-SR04 ECHO -> D6
//
// Додані деталі:
//   Passive Buzzer (+) -> через резистор 100 Ом до D3
//   Passive Buzzer (-) -> GND
//   Active Buzzer (+)  -> D5
//   Active Buzzer (-)  -> GND
//   DHT11 S / DATA      -> D2
//   DHT11 + / VCC       -> 5V
//   DHT11 - / GND       -> GND
//   Joystick VRx        -> A0
//   Joystick VRy        -> A1
//   Joystick SW         -> D4
//   Joystick +5V / VCC  -> 5V
//   Joystick GND        -> GND
//
// Для трьохконтактного модуля DHT11 з набору окрема
// бібліотека та додатковий резистор не потрібні.
// Для джойстика резистор також не потрібен: SW використовує
// внутрішній INPUT_PULLUP Arduino.
// ============================================================

const byte SERVO_PIN = 9;
const byte TRIG_PIN = 7;
const byte ECHO_PIN = 6;
const byte BUZZER_PIN = 3;
const byte ACTIVE_BUZZER_PIN = 5;
const byte DHT_PIN = 2;
const byte JOYSTICK_X_PIN = A0;
const byte JOYSTICK_Y_PIN = A1;
const byte JOYSTICK_SW_PIN = 4;

const int CLOSED_ANGLE = 10;
const int OPEN_ANGLE = 90;
const int RADAR_MIN_ANGLE = 15;
const int RADAR_MAX_ANGLE = 165;

enum DeviceMode {
  GATE_DEVICE,
  RADAR_DEVICE,
  GAME_DEVICE
};

Servo mechanismServo;
DeviceMode deviceMode = GATE_DEVICE;

bool autoMode = false;
int currentAngle = CLOSED_ANGLE;
int distanceLimitCm = 25;
unsigned long holdOpenMs = 3000;
unsigned long lastObjectSeenMs = 0;

int radarDirection = 1;
int radarStepMs = 45;
unsigned long lastRadarStepMs = 0;

unsigned long lastMeasurementMs = 0;
unsigned long lastReportMs = 0;
float distanceCm = -1;
String commandBuffer = "";

unsigned long lastClimateReadMs = 0;
float temperatureC = 0;
float humidityPercent = 0;
bool dhtReadingValid = false;

int joystickX = 512;
int joystickY = 512;
bool joystickPressed = false;

bool gameSoundEnabled = true;
bool gamePaused = false;
bool gameLiveTrackEnabled = false;
byte gameNoteIndex = 0;
unsigned long nextGameNoteMs = 0;
bool activeBuzzerPlaying = false;
bool activeBuzzerPulseOn = false;
byte activeBuzzerPulsesRemaining = 0;
unsigned int activeBuzzerPulseOnMs = 0;
unsigned int activeBuzzerPulseGapMs = 0;
unsigned long activeBuzzerNextMs = 0;
// D5 is a PWM pin. A lower duty cycle makes the Active Buzzer quieter
// without touching the music played by the Passive Buzzer on D3.
byte activeBuzzerVolume = 71; // 28% by default

// --- Ноти для трьох мелодій ---
const unsigned int radarNotes[] = {
  880, 0, 1175, 0, 880, 1319, 1175, 0,
  659, 880, 988, 1175, 0
};
const byte radarBeats[] = {
  8, 16, 8, 16, 8, 8, 8, 16,
  8, 8, 8, 4, 8
};

const unsigned int joyNotes[] = {
  659, 659, 698, 784, 784, 698, 659, 587,
  523, 523, 587, 659, 659, 587, 587,
  659, 659, 698, 784, 784, 698, 659, 587,
  523, 523, 587, 659, 587, 523, 523
};
const byte joyBeats[] = {
  4, 4, 4, 4, 4, 4, 4, 4,
  4, 4, 4, 4, 3, 8, 2,
  4, 4, 4, 4, 4, 4, 4, 4,
  4, 4, 4, 4, 3, 8, 2
};

const unsigned int starNotes[] = {
  523, 523, 784, 784, 880, 880, 784,
  698, 698, 659, 659, 587, 587, 523,
  784, 784, 698, 698, 659, 659, 587,
  784, 784, 698, 698, 659, 659, 587
};
const byte starBeats[] = {
  4, 4, 4, 4, 4, 4, 2,
  4, 4, 4, 4, 4, 4, 2,
  4, 4, 4, 4, 4, 4, 2,
  4, 4, 4, 4, 4, 4, 2
};

// Оригінальна 8-бітна тема «Космічна погоня».
// Чотири музичні частини створюють довший і різноманітніший цикл.
const unsigned int gameNotes[] = {
  330, 494, 659, 784, 0, 659, 494, 392,
  294, 440, 587, 740, 0, 587, 440, 370,

  262, 392, 523, 659, 0, 659, 784, 988,
  247, 370, 494, 622, 0, 740, 622, 494,

  330, 392, 494, 659, 784, 659, 494, 392,
  294, 370, 440, 587, 740, 587, 440, 370,

  262, 330, 392, 523, 659, 523, 392, 330,
  247, 311, 370, 494, 0, 494, 587, 659
};
const byte gameBeats[] = {
  8, 8, 8, 8, 16, 8, 8, 8,
  8, 8, 8, 8, 16, 8, 8, 8,

  8, 8, 8, 8, 16, 8, 8, 8,
  8, 8, 8, 8, 16, 8, 8, 8,

  8, 8, 8, 8, 8, 8, 8, 8,
  8, 8, 8, 8, 8, 8, 8, 8,

  8, 8, 8, 8, 8, 8, 8, 8,
  8, 8, 8, 8, 16, 8, 8, 4
};

const unsigned int* activeNotes = nullptr;
const byte* activeBeats = nullptr;
byte activeMelody = 0;
byte activeNoteIndex = 0;
byte activeNoteCount = 0;
unsigned long nextNoteMs = 0;

bool deadlineReached(unsigned long deadline) {
  return (long)(millis() - deadline) >= 0;
}

void moveServo(int requestedAngle) {
  currentAngle = constrain(requestedAngle, CLOSED_ANGLE, 170);
  mechanismServo.write(currentAngle);
}

float measureDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  // Максимально чекаємо приблизно 4 метри.
  unsigned long duration = pulseIn(ECHO_PIN, HIGH, 24000);
  if (duration == 0) {
    return -1;
  }

  return duration * 0.0343 / 2.0;
}

bool waitWhileDhtLevel(byte level, unsigned int &pulseLength) {
  pulseLength = 0;

  while (digitalRead(DHT_PIN) == level) {
    pulseLength++;
    if (pulseLength >= 1000) {
      return false;
    }
  }

  return true;
}

bool readDht11(float &newTemperature, float &newHumidity) {
  byte data[5] = {0, 0, 0, 0, 0};
  unsigned int pulseLength = 0;
  unsigned int lowLength = 0;
  unsigned int highLength = 0;

  // Arduino просить DHT11 почати передавання.
  pinMode(DHT_PIN, OUTPUT);
  digitalWrite(DHT_PIN, LOW);
  delay(20);
  digitalWrite(DHT_PIN, HIGH);
  delayMicroseconds(40);
  pinMode(DHT_PIN, INPUT_PULLUP);

  // Короткі імпульси треба вимірювати без переривань.
  noInterrupts();

  if (
    !waitWhileDhtLevel(HIGH, pulseLength) ||
    !waitWhileDhtLevel(LOW, pulseLength) ||
    !waitWhileDhtLevel(HIGH, pulseLength)
  ) {
    interrupts();
    return false;
  }

  for (byte bitIndex = 0; bitIndex < 40; bitIndex++) {
    if (
      !waitWhileDhtLevel(LOW, lowLength) ||
      !waitWhileDhtLevel(HIGH, highLength)
    ) {
      interrupts();
      return false;
    }

    data[bitIndex / 8] <<= 1;
    if (highLength > lowLength) {
      data[bitIndex / 8] |= 1;
    }
  }

  interrupts();

  byte checksum = data[0] + data[1] + data[2] + data[3];
  if (checksum != data[4]) {
    return false;
  }

  newHumidity = data[0] + data[1] * 0.1;
  newTemperature = (data[2] & 0x7F) + data[3] * 0.1;
  if (data[2] & 0x80) {
    newTemperature = -newTemperature;
  }

  return (
    newHumidity >= 0 &&
    newHumidity <= 100 &&
    newTemperature >= -20 &&
    newTemperature <= 80
  );
}

void updateClimate() {
  if (millis() - lastClimateReadMs < 2200) {
    return;
  }

  lastClimateReadMs = millis();
  float newTemperature = 0;
  float newHumidity = 0;

  if (readDht11(newTemperature, newHumidity)) {
    temperatureC = newTemperature;
    humidityPercent = newHumidity;
    dhtReadingValid = true;
  } else {
    dhtReadingValid = false;
  }
}

void stopMusic() {
  noTone(BUZZER_PIN);
  activeMelody = 0;
  activeNoteIndex = 0;
  activeNoteCount = 0;
  activeNotes = nullptr;
  activeBeats = nullptr;
}

void startMelody(byte melodyId) {
  stopMusic();

  if (melodyId == 1) {
    activeNotes = radarNotes;
    activeBeats = radarBeats;
    activeNoteCount = sizeof(radarNotes) / sizeof(radarNotes[0]);
  } else if (melodyId == 2) {
    activeNotes = joyNotes;
    activeBeats = joyBeats;
    activeNoteCount = sizeof(joyNotes) / sizeof(joyNotes[0]);
  } else if (melodyId == 3) {
    activeNotes = starNotes;
    activeBeats = starBeats;
    activeNoteCount = sizeof(starNotes) / sizeof(starNotes[0]);
  } else {
    return;
  }

  activeMelody = melodyId;
  activeNoteIndex = 0;
  nextNoteMs = millis();
}

void updateMusic() {
  if (activeMelody == 0 || activeNotes == nullptr || activeBeats == nullptr) {
    return;
  }

  if (!deadlineReached(nextNoteMs)) {
    return;
  }

  if (activeNoteIndex >= activeNoteCount) {
    stopMusic();
    return;
  }

  unsigned int frequency = activeNotes[activeNoteIndex];
  unsigned int noteDuration = 1000 / activeBeats[activeNoteIndex];

  if (frequency == 0) {
    noTone(BUZZER_PIN);
  } else {
    tone(BUZZER_PIN, frequency, noteDuration * 85 / 100);
  }

  nextNoteMs = millis() + noteDuration + noteDuration / 3;
  activeNoteIndex++;
}

void stopActiveBuzzerEffect() {
  analogWrite(ACTIVE_BUZZER_PIN, 0);
  activeBuzzerPlaying = false;
  activeBuzzerPulseOn = false;
  activeBuzzerPulsesRemaining = 0;
  activeBuzzerPulseOnMs = 0;
  activeBuzzerPulseGapMs = 0;
}

void stopDeviceMode() {
  stopActiveBuzzerEffect();

  if (gameLiveTrackEnabled) {
    noTone(BUZZER_PIN);
    gameLiveTrackEnabled = false;
  }

  if (deviceMode == GAME_DEVICE) {
    noTone(BUZZER_PIN);
    gamePaused = false;
    gameNoteIndex = 0;
    nextGameNoteMs = millis();
  }

  deviceMode = GATE_DEVICE;
  autoMode = false;
}

void startGame() {
  stopMusic();
  stopDeviceMode();
  deviceMode = GAME_DEVICE;
  gameSoundEnabled = true;
  gamePaused = false;
  gameLiveTrackEnabled = false;
  gameNoteIndex = 0;
  nextGameNoteMs = millis();
  moveServo(CLOSED_ANGLE);
}

void stopGame() {
  stopDeviceMode();
  moveServo(CLOSED_ANGLE);
}

void startActiveBuzzerPattern(
  unsigned int onDuration,
  unsigned int gapDuration,
  byte pulseCount
) {
  if (onDuration == 0 || pulseCount == 0 || activeBuzzerVolume == 0) {
    stopActiveBuzzerEffect();
    return;
  }

  analogWrite(ACTIVE_BUZZER_PIN, activeBuzzerVolume);
  activeBuzzerPlaying = true;
  activeBuzzerPulseOn = true;
  activeBuzzerPulsesRemaining = pulseCount;
  activeBuzzerPulseOnMs = onDuration;
  activeBuzzerPulseGapMs = gapDuration;
  activeBuzzerNextMs = millis() + onDuration;
}

void playGameEffect(String effect) {
  bool menuEffect = effect == "MENU";
  bool allowedWhilePaused =
    effect == "OVER" || effect == "BOSS" || effect == "ACH" ||
    effect == "RECORD";
  if (
    (deviceMode != GAME_DEVICE && !menuEffect) ||
    (gamePaused && !allowedWhilePaused) ||
    !gameSoundEnabled
  ) {
    return;
  }

  unsigned int onDuration = 0;
  unsigned int gapDuration = 0;
  byte pulseCount = 1;

  if (effect == "SHOT") {
    onDuration = 45;
  } else if (effect == "SCORE") {
    onDuration = 90;
  } else if (effect == "CRASH") {
    onDuration = 220;
  } else if (effect == "OVER") {
    onDuration = 460;
  } else if (effect == "POWER") {
    onDuration = 55;
    gapDuration = 45;
    pulseCount = 3;
  } else if (effect == "SHIELD") {
    onDuration = 75;
    gapDuration = 55;
    pulseCount = 2;
  } else if (effect == "BOSS") {
    onDuration = 140;
    gapDuration = 90;
    pulseCount = 3;
  } else if (effect == "WARN") {
    onDuration = 80;
    gapDuration = 70;
    pulseCount = 3;
  } else if (effect == "ACH") {
    onDuration = 55;
    gapDuration = 40;
    pulseCount = 4;
  } else if (effect == "LASER") {
    onDuration = 160;
  } else if (effect == "MISSILE") {
    onDuration = 70;
    gapDuration = 40;
    pulseCount = 3;
  } else if (effect == "EMP") {
    onDuration = 240;
  } else if (effect == "RECORD") {
    onDuration = 70;
    gapDuration = 45;
    pulseCount = 4;
  } else if (effect == "LOW") {
    onDuration = 65;
    gapDuration = 180;
    pulseCount = 2;
  } else if (effect == "MENU") {
    onDuration = 38;
    gapDuration = 30;
    pulseCount = 2;
  } else {
    return;
  }

  // Active Buzzer має власну фіксовану частоту. D5 керує його
  // гучністю PWM-сигналом. Короткі неблокуючі імпульси розрізняють події
  // та не заважають Passive Buzzer на D3.
  startActiveBuzzerPattern(onDuration, gapDuration, pulseCount);
}

void updateActiveBuzzer() {
  if (!activeBuzzerPlaying || !deadlineReached(activeBuzzerNextMs)) {
    return;
  }

  if (activeBuzzerPulseOn) {
    analogWrite(ACTIVE_BUZZER_PIN, 0);
    activeBuzzerPulseOn = false;

    if (activeBuzzerPulsesRemaining <= 1) {
      stopActiveBuzzerEffect();
      return;
    }

    activeBuzzerPulsesRemaining--;
    activeBuzzerNextMs = millis() + activeBuzzerPulseGapMs;
    return;
  }

  analogWrite(ACTIVE_BUZZER_PIN, activeBuzzerVolume);
  activeBuzzerPulseOn = true;
  activeBuzzerNextMs = millis() + activeBuzzerPulseOnMs;
}

void updateGameAudio() {
  if (
    deviceMode != GAME_DEVICE ||
    gamePaused ||
    !gameSoundEnabled ||
    gameLiveTrackEnabled ||
    !deadlineReached(nextGameNoteMs)
  ) {
    return;
  }

  const byte noteCount = sizeof(gameNotes) / sizeof(gameNotes[0]);
  if (gameNoteIndex >= noteCount) {
    gameNoteIndex = 0;
  }

  unsigned int noteDuration = 1000 / gameBeats[gameNoteIndex];
  unsigned int frequency = gameNotes[gameNoteIndex];
  if (frequency == 0) {
    noTone(BUZZER_PIN);
  } else {
    tone(
      BUZZER_PIN,
      frequency,
      noteDuration * 78 / 100
    );
  }
  nextGameNoteMs = millis() + noteDuration + 28;
  gameNoteIndex++;
}

void updateJoystick() {
  joystickX = analogRead(JOYSTICK_X_PIN);
  joystickY = analogRead(JOYSTICK_Y_PIN);
  joystickPressed = digitalRead(JOYSTICK_SW_PIN) == LOW;
}

void startRadar() {
  stopDeviceMode();
  autoMode = false;
  deviceMode = RADAR_DEVICE;
  radarDirection = 1;
  moveServo(RADAR_MIN_ANGLE);
  lastRadarStepMs = millis();
}

void stopRadar() {
  stopDeviceMode();
  moveServo(CLOSED_ANGLE);
}

void sendStatus() {
  Serial.print("{\"distance\":");
  if (distanceCm < 0) {
    Serial.print("null");
  } else {
    Serial.print(distanceCm, 1);
  }

  Serial.print(",\"angle\":");
  Serial.print(currentAngle);

  Serial.print(",\"device\":\"");
  if (deviceMode == RADAR_DEVICE) {
    Serial.print("radar");
  } else if (deviceMode == GAME_DEVICE) {
    Serial.print("game");
  } else {
    Serial.print("gate");
  }

  Serial.print("\",\"mode\":\"");
  Serial.print(autoMode ? "auto" : "manual");

  Serial.print("\",\"gate\":\"");
  Serial.print(currentAngle >= 55 ? "open" : "closed");

  Serial.print("\",\"limit\":");
  Serial.print(distanceLimitCm);

  Serial.print(",\"hold\":");
  Serial.print(holdOpenMs);

  Serial.print(",\"scanSpeed\":");
  Serial.print(radarStepMs);

  Serial.print(",\"music\":");
  Serial.print(activeMelody);

  Serial.print(",\"temperature\":");
  if (dhtReadingValid) {
    Serial.print(temperatureC, 1);
  } else {
    Serial.print("null");
  }

  Serial.print(",\"humidity\":");
  if (dhtReadingValid) {
    Serial.print(humidityPercent, 1);
  } else {
    Serial.print("null");
  }

  Serial.print(",\"dhtOk\":");
  Serial.print(dhtReadingValid ? "true" : "false");

  Serial.print(",\"joystickX\":");
  Serial.print(joystickX);

  Serial.print(",\"joystickY\":");
  Serial.print(joystickY);

  Serial.print(",\"joystickPressed\":");
  Serial.print(joystickPressed ? "true" : "false");

  Serial.print(",\"gameSound\":");
  Serial.print(gameSoundEnabled ? "true" : "false");

  Serial.println("}");
}

void handleCommand(String command) {
  command.trim();
  if (command.length() == 0) return;

  if (command == "OPEN") {
    stopRadar();
    moveServo(OPEN_ANGLE);
  } else if (command == "CLOSE") {
    stopRadar();
    moveServo(CLOSED_ANGLE);
  } else if (command == "STATUS") {
    sendStatus();
  } else if (command.startsWith("ANGLE:")) {
    stopRadar();
    moveServo(constrain(command.substring(6).toInt(), CLOSED_ANGLE, OPEN_ANGLE));
  } else if (command.startsWith("AUTO:")) {
    if (command.substring(5).toInt() == 1) {
      stopDeviceMode();
      autoMode = true;
    } else {
      autoMode = false;
    }
  } else if (command.startsWith("LIMIT:")) {
    distanceLimitCm = constrain(command.substring(6).toInt(), 8, 80);
  } else if (command.startsWith("HOLD:")) {
    holdOpenMs = constrain(command.substring(5).toInt(), 1000, 10000);
  } else if (command.startsWith("RADAR:")) {
    if (command.substring(6).toInt() == 1) {
      startRadar();
    } else {
      stopRadar();
    }
  } else if (command.startsWith("SCAN:")) {
    radarStepMs = constrain(command.substring(5).toInt(), 30, 100);
  } else if (command == "MUSIC:STOP") {
    stopMusic();
  } else if (command.startsWith("MUSIC:")) {
    startMelody(constrain(command.substring(6).toInt(), 1, 3));
  } else if (command == "GAME:1") {
    startGame();
  } else if (command == "GAME:0") {
    stopGame();
  } else if (command == "GAME:PAUSE") {
    if (deviceMode == GAME_DEVICE) {
      gamePaused = true;
      noTone(BUZZER_PIN);
      stopActiveBuzzerEffect();
    }
  } else if (command == "GAME:RESUME") {
    if (deviceMode == GAME_DEVICE) {
      gamePaused = false;
      nextGameNoteMs = millis();
    }
  } else if (command == "GAME:OVER") {
    if (deviceMode == GAME_DEVICE) {
      gamePaused = false;
      playGameEffect("OVER");
      // Після ефекту гра лишається на паузі, а музика не запускається знову.
      gamePaused = true;
    }
  } else if (command.startsWith("GAME:SOUND:")) {
    gameSoundEnabled = command.substring(11).toInt() == 1;
    if (!gameSoundEnabled) {
      noTone(BUZZER_PIN);
      stopActiveBuzzerEffect();
    } else {
      nextGameNoteMs = millis();
    }
  } else if (command == "TRACK:START") {
    stopMusic();
    gameLiveTrackEnabled = true;
    gamePaused = false;
    noTone(BUZZER_PIN);
  } else if (command == "TRACK:STOP") {
    // Залишаємо live-режим увімкненим, щоб зупинка плеєра
    // означала тишу, а не повернення вбудованої мелодії.
    gameLiveTrackEnabled = true;
    noTone(BUZZER_PIN);
  } else if (command.startsWith("TRACK:TONE:")) {
    int separator = command.indexOf(':', 11);
    if (separator > 11) {
      int frequency = constrain(
        command.substring(11, separator).toInt(),
        0,
        4000
      );
      int duration = constrain(
        command.substring(separator + 1).toInt(),
        20,
        1000
      );

      if (
        gameLiveTrackEnabled &&
        !gamePaused &&
        gameSoundEnabled
      ) {
        if (frequency == 0) {
          noTone(BUZZER_PIN);
        } else {
          tone(BUZZER_PIN, frequency, duration);
        }
      }
    }
  } else if (command.startsWith("SFX:VOLUME:")) {
    int percent = constrain(command.substring(11).toInt(), 0, 100);
    activeBuzzerVolume = map(percent, 0, 100, 0, 255);
    if (percent == 0) {
      stopActiveBuzzerEffect();
    }
  } else if (command.startsWith("SFX:")) {
    playGameEffect(command.substring(4));
  }
}

void readSerialCommands() {
  while (Serial.available() > 0) {
    char incoming = Serial.read();

    if (incoming == '\n') {
      handleCommand(commandBuffer);
      commandBuffer = "";
    } else if (incoming != '\r' && commandBuffer.length() < 40) {
      commandBuffer += incoming;
    }
  }
}

void updateRadar() {
  if (deviceMode != RADAR_DEVICE) return;
  if (millis() - lastRadarStepMs < (unsigned long)radarStepMs) return;

  lastRadarStepMs = millis();
  int nextAngle = currentAngle + radarDirection * 2;

  if (nextAngle >= RADAR_MAX_ANGLE) {
    nextAngle = RADAR_MAX_ANGLE;
    radarDirection = -1;
  } else if (nextAngle <= RADAR_MIN_ANGLE) {
    nextAngle = RADAR_MIN_ANGLE;
    radarDirection = 1;
  }

  moveServo(nextAngle);
}

void updateDistanceAndGate() {
  if (deviceMode == GAME_DEVICE) return;

  unsigned long measurementInterval =
    deviceMode == RADAR_DEVICE ? 65 : 120;

  if (millis() - lastMeasurementMs < measurementInterval) return;

  lastMeasurementMs = millis();
  distanceCm = measureDistanceCm();

  if (deviceMode == GATE_DEVICE && autoMode) {
    if (distanceCm > 0 && distanceCm <= distanceLimitCm) {
      lastObjectSeenMs = millis();
      moveServo(OPEN_ANGLE);
    } else if (
      currentAngle != CLOSED_ANGLE &&
      millis() - lastObjectSeenMs >= holdOpenMs
    ) {
      moveServo(CLOSED_ANGLE);
    }
  }
}

void setup() {
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(ACTIVE_BUZZER_PIN, OUTPUT);
  analogWrite(ACTIVE_BUZZER_PIN, 0);
  pinMode(DHT_PIN, INPUT_PULLUP);
  pinMode(JOYSTICK_SW_PIN, INPUT_PULLUP);

  mechanismServo.attach(SERVO_PIN);
  moveServo(CLOSED_ANGLE);

  Serial.begin(115200);
  lastClimateReadMs = millis();
  delay(300);
  sendStatus();
}

void loop() {
  readSerialCommands();
  updateJoystick();
  updateMusic();
  updateGameAudio();
  updateActiveBuzzer();
  updateRadar();
  updateDistanceAndGate();
  updateClimate();

  unsigned long reportInterval = 250;
  if (deviceMode == RADAR_DEVICE) {
    reportInterval = 100;
  } else if (deviceMode == GAME_DEVICE) {
    reportInterval = 50;
  }

  if (millis() - lastReportMs >= reportInterval) {
    lastReportMs = millis();
    sendStatus();
  }
}
